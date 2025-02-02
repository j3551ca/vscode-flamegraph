import * as fs from 'fs';
import { basename } from 'path';
import { strToHue } from './utilities/colors';
import { getModuleName, toUnixPath } from './utilities/pathUtils';

type FrameId = number;
type FunctionId = number;
type LineNumber = number;

export type Function = {
    functionName: string;
    shortFunctionName?: string;
    filePath?: string;
    fileName?: string;
    module?: string;
    moduleHue: number; // for module name
    functionHue?: number; // for function name
};

export type Flamenode = {
    uid: number;
    parentUid?: number;
    frameId: FrameId; // unique id for the frame, which is (functionName, filePath, lineNumber)
    functionId: FunctionId; // unique id for the function, which is (functionName, filePath)
    line?: LineNumber; // line number of the source code for this node
    sourceCode?: string; // the string of source code for this line
    depth: number; // depth in the tree
    samples: number; // total number of samples for this node as recorded in the profile
    ownSamples: number; // for recursive functions, this is the number of samples for the deepest occurrence
    children: Flamenode[];
    enterTime?: number; // Euler tour enter time
    exitTime?: number; // Euler tour exit time
};

type LineProfile = {
    line: number;
    nodes: Flamenode[];
};

type FileIndex = {
    // map fileName to a list of matching filePaths
    [fileName: string]: {
        filePath: string;
        lineProfiles: LineProfile[]; // profile data associated with lines in the file
    }[];
};

export class Flamegraph {
    private frameCache: Map<string, [FrameId, FunctionId, LineNumber | undefined]>;

    private functionCache: Map<string, FunctionId>;

    public root: Flamenode; // root node of the flamegraph

    public nodes: Flamenode[]; // array of all nodes in the flamegraph, where node is at index node.uid in the array

    public functions: Function[]; // array of all functions in the flamegraph, where function is at index
    // function.functionId in the array

    public index: FileIndex; // index of the flamegraph, used for efficient lookup of profile data for a single file

    /**
     * Constructor for the Flamegraph class.
     * @param data - The profile data to be parsed. This should be the raw output of py-spy as a string.
     */
    constructor(data: string) {
        this.functions = [{ functionName: 'all', moduleHue: 240, functionHue: 240 }];
        this.frameCache = new Map();
        this.functionCache = new Map();
        this.nodes = [];
        this.index = {};
        this.root = {
            uid: 0,
            frameId: -1,
            functionId: 0,
            depth: 0,
            samples: 0,
            ownSamples: 0,
            children: [],
        };
        this.nodes.push(this.root);

        this.parseFlamegraph(data);
        this.assignEulerTimes(this.root);
        this.buildIndex();
        this.addSourceCode();
    }

    /**
     * Parses a frame string into a frame ID, function ID, and line number.
     * @param frameString - The frame string to parse.
     * @returns A tuple containing the frame ID, function ID, and line number.
     */
    private parseFrame(frameString: string): [number | undefined, number | undefined, number | undefined] {
        if (this.frameCache.has(frameString)) {
            return this.frameCache.get(frameString)!;
        }
        // match regex of the form
        // <functionName> (<filePath>:<lineNumber>)
        // <functionName> (<filePath>)
        // <functionName>
        const frameRegex = /^(.+?)(?:\s+\(([^)]+?)(?::(\d+))?\))?$/;
        const matches = frameString.match(frameRegex);

        if (!matches) return [undefined, undefined, undefined];
        const [, functionName, filePath, lineNumberStr] = matches;
        if (!functionName) return [undefined, undefined, undefined]; // A function name should always be defined

        const line = lineNumberStr ? parseInt(lineNumberStr, 10) : undefined;
        const functionKey = `${functionName} ${filePath}`;

        let functionId: FunctionId;
        if (this.functionCache.has(functionKey)) {
            functionId = this.functionCache.get(functionKey)!;
        } else {
            const fileName = filePath ? basename(filePath) : undefined;
            const module = /process \d+/.test(functionName) ? 'process' : (getModuleName(filePath) ?? undefined);
            const functionHue = strToHue(functionName);
            const moduleHue = module ? strToHue(module) : functionHue;

            // Extract "process <number>" if the function name matches the pattern
            const processRegex = /^process\s+(\d+)(?:\s+|:).+/;
            const processMatches = functionName.match(processRegex);
            const shortFunctionName = processMatches ? `process ${processMatches[1]}` : undefined;

            const func: Function = {
                functionName,
                shortFunctionName,
                filePath,
                fileName,
                module,
                functionHue,
                moduleHue,
            };

            functionId = this.functions.length;
            this.functionCache.set(functionKey, functionId);
            this.functions.push(func);
        }

        const frameId = this.frameCache.size;
        this.frameCache.set(frameString, [frameId, functionId, line]);
        return [frameId, functionId, line];
    }

    /**
     * Assigns Euler times to the nodes in the flamegraph. These are used for O(1) child/ancestor queries.
     * @param node - The root node of the flamegraph.
     */
    private assignEulerTimes(node: Flamenode) {
        let time = 0;
        const assign = (n: Flamenode) => {
            time += 1;
            n.enterTime = time;
            for (const child of n.children) {
                assign(child);
            }
            time += 1;
            n.exitTime = time;
        };
        assign(node);
    }

    /**
     * Parses the flamegraph string into a tree of nodes. This will populate the `this.root` node and the `this.nodes`
     * array.
     * @param flamegraphString - The flamegraph string to parse.
     */
    public parseFlamegraph(flamegraphString: string): void {
        const rows = flamegraphString.trim().split('\n');

        for (const row of rows) {
            const lastSpaceIndex = row.lastIndexOf(' ');
            if (lastSpaceIndex === -1) continue;

            const stackTraceStr = row.substring(0, lastSpaceIndex);
            const samples = parseInt(row.substring(lastSpaceIndex + 1), 10);
            this.root.samples += samples;
            const stackTrace = stackTraceStr.split(';');

            // count the number of occurrences of each string in the stack trace
            const stackTraceCounts = new Map<number, number>();
            const frames: { frameId: number; functionId: number; line: number | undefined }[] = [];
            for (const frameString of stackTrace) {
                const [frameId, functionId, line] = this.parseFrame(frameString);
                if (frameId === undefined || functionId === undefined) continue;

                frames.push({ frameId, functionId, line });
                stackTraceCounts.set(functionId, (stackTraceCounts.get(functionId) ?? 0) + 1);
            }

            let current = this.root;

            for (const { frameId, functionId, line } of frames) {
                // Recursive functions appear multiple times in the stack trace.
                // In this case, we assign the samples only to the deepest occurrence.
                // This approach works most of the time. It fails however, when recursive calls involve two functions.
                // TODO: Come up with a better solution.
                const occurrences = stackTraceCounts.get(functionId) ?? 0;
                if (occurrences > 1) stackTraceCounts.set(functionId, occurrences - 1);

                const existingChild = current.children.find((child) => child.frameId === frameId);

                if (existingChild) {
                    current = existingChild;
                    current.samples += samples;
                    if (occurrences === 1) current.ownSamples += samples;
                } else {
                    const newNode: Flamenode = {
                        uid: this.nodes.length,
                        parentUid: current.uid,
                        frameId,
                        functionId,
                        line,
                        depth: current.depth + 1,
                        samples,
                        ownSamples: occurrences === 1 ? samples : 0,
                        children: [],
                    };
                    current.children.push(newNode);
                    this.nodes.push(newNode);
                    current = newNode;
                }
            }
        }
    }

    /**
     * Builds an index of the flamegraph. This will populate the `this.index` object.
     * The index is used to quickly find profile data for a single file.
     */
    private buildIndex() {
        // sort nodes by line number and own samples
        const sortedNodes = [...this.nodes].sort((a, b) => {
            const lineA = a.line ?? 0;
            const lineB = b.line ?? 0;
            if (lineA !== lineB) return lineA - lineB;
            return b.ownSamples - a.ownSamples;
        });

        // Build index
        // The index allows for efficient lookup of profile data for a single file.
        // Essentially, the strategy is as follows:
        // Pass a filename to the index, and it will return a list of file paths that match the filename.
        // Given the file path, line profiles are returned for the file, which corresponds to list of nodes for
        // each line.
        // filename -> [filePaths] -> [line] -> [nodes]
        this.index = {};
        for (const node of sortedNodes) {
            const { filePath, fileName, functionName } = this.functions[node.functionId];

            if (functionName.startsWith('<') && functionName.endsWith('>') && functionName !== '<module>') continue;

            const { line } = node;

            if (!line || !filePath || !fileName) continue;

            const name = fileName.toLowerCase();
            this.index[name] ??= [];
            const fileIndex = this.index[name];
            const i = fileIndex.findIndex((x) => x.filePath.toLowerCase() === filePath.toLowerCase());
            if (i === -1) {
                const fileProfile = {
                    filePath: filePath.toLowerCase(),
                    lineProfiles: [{ line, nodes: [node] }],
                };
                fileIndex.push(fileProfile);
                continue;
            }

            const lineProfile = fileIndex[i].lineProfiles;
            const j = lineProfile.findIndex((x) => x.line === line);
            if (j === -1) {
                lineProfile.push({ line, nodes: [node] });
            } else {
                lineProfile[j].nodes.push(node);
            }
        }
    }

    /**
     * Gets the profile data for a single file. While also allowing for filtering of the profile data by a focus node.
     * Only nodes that are children or ancestors of the focus node will be returned. This corresponds to visible nodes
     * in the react flamegraph.
     * @param filePath - The path to the file.
     * @param focusUid - The UID of the focus node that is selected in the react flamegraph. Only profile data of
     * children or ancestors of the focus node will be returned. This ensures that the profile data is synchronized
     * with the visible nodes in the react flamegraph.
     * @returns The profile data for the file, as an array of LineProfile objects.
     */
    public getFileProfile(filePath: string, focusUid?: number[]): LineProfile[] | undefined {
        filePath = toUnixPath(filePath).toLowerCase(); // use lower case since Windows is case insensitive
        // TODO: only use lower case on OS that are case insensitive
        const filename = basename(filePath);

        const fileIndex = this.index[filename];
        if (!fileIndex) return undefined;

        const i = fileIndex.findIndex((x) => {
            const indexFilePath = toUnixPath(x.filePath);
            return indexFilePath.endsWith(filePath) || filePath.endsWith(indexFilePath);
        });
        if (i === -1) return undefined;

        const { lineProfiles } = fileIndex[i];
        if (!lineProfiles) return undefined;
        if (!focusUid || (focusUid.length === 1 && focusUid[0] === 0)) return lineProfiles;

        const filteredLineProfiles: LineProfile[] = [];
        for (const lineProfile of lineProfiles) {
            const { line, nodes } = lineProfile;
            const filteredNodes = this.filterNodes(nodes, focusUid);
            if (filteredNodes.length === 0) continue;
            filteredLineProfiles.push({ line, nodes: filteredNodes });
        }
        return filteredLineProfiles;
    }

    /**
     * Filters the nodes to only include those that are children or ancestors of the focus node.
     * @param nodes - The nodes to filter.
     * @param focusUid - The UID of the focus node.
     * @returns The filtered nodes.
     */
    private filterNodes(nodes: Flamenode[], focusUid: number[]): Flamenode[] {
        return nodes.filter((node) => {
            for (const uid of focusUid) {
                const focusNode = this.nodes[uid];
                if (node.ownSamples > 0 && this.isChildOrAncestor(node, focusNode)) return true;
            }
            return false;
        });
    }

    /**
     * Checks if a node is a child or ancestor of another node.
     * @param a - The first node.
     * @param b - The second node.
     * @returns True if a is a child or ancestor of b, false otherwise.
     */
    public isChildOrAncestor(a: Flamenode, b: Flamenode): boolean {
        if (!a.enterTime || !a.exitTime || !b.enterTime || !b.exitTime) return false;
        return (
            (a.enterTime <= b.enterTime && a.exitTime >= b.exitTime) ||
            (b.enterTime <= a.enterTime && b.exitTime >= a.exitTime)
        );
    }

    /**
     * Adds source code to the nodes in the flamegraph. For efficiency this can only be called after the index has been
     * built. Then source code files are read once for each file, and the relevant lines are added to the nodes.
     */
    public addSourceCode(): void {
        // Process one file at a time
        for (const fileName in this.index) {
            if (!Object.prototype.hasOwnProperty.call(this.index, fileName)) continue;
            const fileProfiles = this.index[fileName];

            for (const fileProfile of fileProfiles) {
                if (!fileProfile.filePath.endsWith('.py')) continue;
                try {
                    // Read file content once for all nodes in this file
                    const fileContent = fs.readFileSync(fileProfile.filePath, 'utf-8');
                    const lines = fileContent.split('\n');

                    // Process all line profiles for this file
                    for (const lineProfile of fileProfile.lineProfiles) {
                        const sourceLine = lines[lineProfile.line - 1]?.trim() || '';

                        // Add source code to all nodes for this line
                        for (const node of lineProfile.nodes) {
                            node.sourceCode = sourceLine;
                        }
                    }
                } catch (error) {
                    continue;
                }
            }
        }
    }

    /**
     * Gets the call stack for a node.
     * @param node - The node to get the call stack for.
     * @returns The call stack as an array of function names.
     */
    public getCallStack(node: Flamenode): string[] {
        const stack: string[] = [];
        let currentUid: number | undefined = node.uid;

        while (currentUid !== undefined && currentUid !== 0) {
            const currentNode: Flamenode = this.nodes[currentUid];
            const func = this.functions[currentNode.functionId];
            stack.push(func.shortFunctionName ?? func.functionName);
            currentUid = currentNode.parentUid;
        }
        return stack.reverse();
    }
}
