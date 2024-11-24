import * as vscode from 'vscode';
import { ProfilingEntry, ProfilingResult, ProfilingResults } from './utilities/ProfileParser';
import { getColorByIndex } from './utilities/colors';
import { basename } from 'path';
import { normalizePath } from './utilities/getUri';

const DECORATION_WIDTH = 100; // Width in pixels for the decoration area

// Create a decorator type for the line coloring
export const lineColorDecorationType = vscode.window.createTextEditorDecorationType({
    before: {},
});

function makeToolTip(samples: ProfilingEntry[]) {
    if (samples.length <= 1) return '';
    let toolTip = `### Call Stack\n| | | | |\n|---|---|---|---|\n`;
    let totalSamples = samples.reduce((acc, sample) => acc + sample.numSamples, 0);

    for (const sample of samples) {
        const percentage = ((sample.numSamples / totalSamples) * 100).toFixed(1);
        const barElements = 15;
        const barLength = Math.round((sample.numSamples / totalSamples) * barElements);
        const bar = '█'.repeat(barLength) + ' '.repeat(barElements - barLength);
        toolTip += `| ${sample.numSamples / 100}s | ${bar} | ${percentage}% | ${sample.callStackString} ${Array.from(
            sample.callStackUids
        ).join(',')}|\n`;
    }
    return toolTip;
}

// Function to update decorations
export function updateDecorations(
    activeEditor: vscode.TextEditor | undefined,
    result: ProfilingResults,
    workspaceState: vscode.Memento
) {
    if (!activeEditor || activeEditor.document.languageId !== 'python') return;

    const focusNode: number = workspaceState.get('focusNode') || 0;
    const focusFunctionName: string = workspaceState.get('focusFunctionName') || 'all';

    const decorations: vscode.DecorationOptions[] = [];
    const documentLines = activeEditor.document.lineCount;
    let filePath = normalizePath(activeEditor.document.fileName);
    let fileName = basename(filePath);

    if (!(fileName in result)) return;

    let profilingResults = result[fileName];
    let profilingResult: ProfilingResult | undefined = undefined;

    // check if the file path is in the profiling results
    for (let i = 0; i < profilingResults.length; i++) {
        // the file path need not match exactly, but one should be the end of the other.
        // This ensures that relative paths are also matched.
        const resultFilePath = normalizePath(profilingResults[i].filePath);
        if (resultFilePath.endsWith(filePath) || filePath.endsWith(resultFilePath)) {
            profilingResult = profilingResults[i];
            break;
        }
    }
    if (!profilingResult) return;

    let colorIndex = -1;
    let lastFunctionName = '';
    let color = getColorByIndex(0);

    let focusNodeCallStack = workspaceState.get('focusNodeCallStack') as Set<number>;

    for (let line = 1; line < documentLines + 1; line++) {
        let width = 0;
        let toolTip = '';
        let samples = 0;

        if (line in profilingResult.profile) {
            const lineProfile = profilingResult.profile[line];
            const functionName = lineProfile.functionName;
            // const callStacks = lineProfile.samples[0].numSamples;

            if (functionName !== lastFunctionName) {
                color = getColorByIndex(++colorIndex);
                lastFunctionName = functionName;
            }
            const stats = profilingResult.functionProfile[functionName];
            let totalSamples = 0;

            for (const stat of stats) if (stat.callStackUids.has(focusNode)) totalSamples += stat.totalSamples;

            let contr: ProfilingEntry[] = [];

            for (const sample of lineProfile.samples) {
                if (sample.callStackUids.has(focusNode)) {
                    samples += sample.numSamples;
                    contr.push(sample);
                }

                // If the sample is in the call stack of the focus node, process it
                // This tracks profiling info for all parent nodes of the focus node.
                // There is a caveat for recursive calls: we must ensure that the parent node is not part of the same
                // function as the focus node.
                if (focusNodeCallStack.has(sample.uid) && focusFunctionName !== sample.functionName) {
                    samples += sample.numSamples;
                    totalSamples += sample.numSamples;
                }
            }

            toolTip = makeToolTip(contr);
            width = samples == 0 ? 0 : Math.round((samples / totalSamples) * DECORATION_WIDTH);
        }
        decorations.push({
            range: new vscode.Range(line - 1, 0, line - 1, 0),
            renderOptions: {
                before: {
                    backgroundColor: color,
                    contentText: samples > 0 ? `${(samples / 100).toFixed(2)}s` : '',
                    color: 'white',
                    width: `${width}px`,
                    margin: `0px ${DECORATION_WIDTH - width}px 0px 0px`,
                    fontWeight: 'bold',
                },
            },
            hoverMessage: new vscode.MarkdownString(toolTip),
        });
    }

    activeEditor.setDecorations(lineColorDecorationType, decorations);
}
