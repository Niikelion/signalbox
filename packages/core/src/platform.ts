export const isRoot = (): boolean =>
    process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0
