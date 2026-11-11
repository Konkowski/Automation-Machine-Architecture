// Text files bundled as strings (Vite "?raw" imports; tests/run.mjs does the same for esbuild).
declare module '*?raw' {
    const content: string;
    export default content;
}
