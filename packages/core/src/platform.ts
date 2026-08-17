/** Whether the current process runs as root (always false on Windows). */
export const isRoot = (): boolean =>
    process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0
