/**
 * Represents an item in the legend shown at the bottom of the flamegraph.
 */
export interface LegendItem {
    name: string;
    hue: number;
    totalValue: number;
}

type FrameId = number;
type FunctionId = number;
type LineNumber = number;

export type Function = {
    functionName: string;
    filePath?: string;
    fileName?: string;
    module?: string;
    moduleHue: number; // for module name
    functionHue?: number; // for function name
};

export type Flamenode = {
    uid: number;
    frameId: FrameId; // unique id for the frame, which is (functionName, filePath, lineNumber)
    functionId: FunctionId; // unique id for the function, which is (functionName, filePath)
    line?: LineNumber;
    depth: number;
    samples: number;
    ownSamples: number;
    children: Flamenode[];
    enterTime?: number;
    exitTime?: number;
    parent?: Flamenode;
    codeLine?: string;
};
