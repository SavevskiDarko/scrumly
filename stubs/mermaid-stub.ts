/**
 * Excalidraw dynamically imports @excalidraw/mermaid-to-excalidraw for its
 * "Mermaid to Excalidraw" dialog, which drags in mermaid, cytoscape and katex —
 * roughly four megabytes we never use.
 *
 * In the normal build those stay lazy chunks and cost nothing. The single-file
 * build has to inline every chunk, so there we alias the package to this stub.
 * The import is dynamic, so nothing breaks unless that one dialog is opened.
 */
export function parseMermaidToExcalidraw(): never {
  throw new Error('Mermaid import is not included in the single-file build. Run the full app for it.')
}
export default { parseMermaidToExcalidraw }
