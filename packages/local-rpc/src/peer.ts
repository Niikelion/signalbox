import { Socket } from "node:net"
import { constants, endianness } from "node:os"
import koffi from "koffi"
import { LocalRpcError, type LocalRpcPeer } from "./types"

/** Socket-option numbers for reading peer credentials. These vary by CPU ABI. */
interface SocketAbi {
    readonly SOL_SOCKET: number
    readonly SO_PEERCRED: number
    readonly SO_PEERGROUPS: number
}

/** asm-generic ABI: x86-64, ARM, ARM64, RISC-V, s390x, ppc64(le). */
const GENERIC_ABI: SocketAbi = { SOL_SOCKET: 1, SO_PEERCRED: 17, SO_PEERGROUPS: 59 }
/** MIPS assigns distinct numbers (arch/mips/include/uapi/asm/socket.h). */
const MIPS_ABI: SocketAbi = { SOL_SOCKET: 0xffff, SO_PEERCRED: 18, SO_PEERGROUPS: 59 }

/**
 * Resolve the socket-option ABI for a CPU architecture. There is no portable
 * runtime source for these numbers (they are C preprocessor macros, not libc
 * symbols), so unknown architectures fail closed rather than risk reading the
 * wrong option and returning bogus credentials.
 */
const socketAbiFor = (arch: string): SocketAbi => {
    switch (arch) {
        case "mips":
        case "mipsel":
            return MIPS_ABI
        case "x64":
        case "arm":
        case "arm64":
        case "riscv64":
        case "s390x":
        case "ppc64":
            return GENERIC_ABI
        default:
            throw new LocalRpcError(
                "UNSUPPORTED_PLATFORM",
                `@signalbox/local-rpc cannot verify peer credentials on CPU architecture "${arch}"`,
            )
    }
}

const PEER_CREDENTIAL_BYTES = 12
const MAX_SUPPLEMENTARY_GROUPS = 64

interface SocketHandle {
    readonly fd?: unknown
}

interface SocketWithHandle extends Socket {
    readonly _handle?: SocketHandle
}

type GetSocketOption = (fd: number, level: number, option: number, value: Buffer, length: number[]) => number

let getSocketOption: GetSocketOption | undefined

const loadGetSocketOption = (): GetSocketOption => {
    if (process.platform !== "linux") {
        throw new LocalRpcError("UNSUPPORTED_PLATFORM", "@signalbox/local-rpc supports Linux only")
    }
    if (getSocketOption) return getSocketOption

    getSocketOption = koffi
        .load(null)
        .func("getsockopt", "int", [
            "int",
            "int",
            "int",
            "void *",
            koffi.inout(koffi.pointer("uint32_t")),
        ]) as GetSocketOption
    return getSocketOption
}

export const readPeerCredentials = (socket: Socket): LocalRpcPeer => {
    const fd = (socket as SocketWithHandle)._handle?.fd
    if (!Number.isInteger(fd) || (fd as number) < 0) {
        throw new LocalRpcError("PEER_CREDENTIALS_UNAVAILABLE", "accepted socket file descriptor is unavailable")
    }

    const getsockopt = loadGetSocketOption()
    const abi = socketAbiFor(process.arch)

    const credentials = Buffer.alloc(PEER_CREDENTIAL_BYTES)
    const length = [credentials.length]
    if (getsockopt(fd as number, abi.SOL_SOCKET, abi.SO_PEERCRED, credentials, length) !== 0) {
        throw new LocalRpcError(
            "PEER_CREDENTIALS_UNAVAILABLE",
            `failed to read peer credentials (errno ${koffi.errno()})`,
        )
    }
    if (length[0] !== credentials.length) {
        throw new LocalRpcError("PEER_CREDENTIALS_UNAVAILABLE", "kernel returned invalid peer credentials")
    }

    const littleEndian = endianness() === "LE"
    const readInt32 = (buffer: Buffer, offset: number): number =>
        littleEndian ? buffer.readInt32LE(offset) : buffer.readInt32BE(offset)
    const readUint32 = (buffer: Buffer, offset: number): number =>
        littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)

    // SO_PEERGROUPS does not truncate: with too small a buffer it fails with
    // ERANGE and reports the required size, so retry once at that size rather
    // than silently dropping the peer's supplementary groups.
    let groupBuffer = Buffer.alloc(MAX_SUPPLEMENTARY_GROUPS * 4)
    let groupLength = [groupBuffer.length]
    let groupResult = getsockopt(fd as number, abi.SOL_SOCKET, abi.SO_PEERGROUPS, groupBuffer, groupLength)
    const requiredGroupBytes = groupLength[0] ?? 0
    if (groupResult !== 0 && koffi.errno() === constants.errno.ERANGE && requiredGroupBytes > groupBuffer.length) {
        groupBuffer = Buffer.alloc(requiredGroupBytes)
        groupLength = [groupBuffer.length]
        groupResult = getsockopt(fd as number, abi.SOL_SOCKET, abi.SO_PEERGROUPS, groupBuffer, groupLength)
    }
    const returnedGroupBytes = groupLength[0] ?? 0
    const hasGroups = groupResult === 0 && returnedGroupBytes <= groupBuffer.length && returnedGroupBytes % 4 === 0
    const supplementaryGids = hasGroups
        ? Array.from({ length: returnedGroupBytes / 4 }, (_, index) => readUint32(groupBuffer, index * 4))
        : undefined

    return {
        pid: readInt32(credentials, 0),
        uid: readUint32(credentials, 4),
        gid: readUint32(credentials, 8),
        ...(supplementaryGids === undefined ? {} : { supplementaryGids }),
    }
}
