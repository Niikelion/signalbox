/** A fully documented function.
 * @typeParam T the returned value type
 * @param required a required value
 * @param optional an optional label
 * @param rest additional numbers
 */
export function documented<T>(required: T, optional?: string, ...rest: number[]): T {
    return required
}

/** A documented overload.
 * @param value the value to convert
 */
export function overloaded(value: string): string
export function overloaded(value: number): number
export function overloaded(value: string | number): string | number {
    return value
}

/** Public API with methods, properties, and callbacks. */
export interface Surface {
    /** A documented property. */
    value: string
    /** A documented method.
     * @param input the input value
     */
    method(input: string): void
    /** A documented callback.
     * @typeParam T the callback value type
     * @param input the callback input
     */
    callback: <T>(input: T) => void
}

/** A parent API. */
export interface ParentSurface {
    /** Documentation inherited by overrides. */
    inheritedDocumentation: string
}

/** A child API. */
export interface ChildSurface extends ParentSurface {
    /** {@inheritDoc ParentSurface.inheritedDocumentation} */
    inheritedDocumentation: string
}

/** A public base class. */
export class Base {
    /** An inherited member. */
    inherited(): void {}
}

/** A public child class. */
export class Child extends Base {
    /** A public constructor.
     * @param value the initial value
     */
    public constructor(public value: string) {
        super()
    }

    private hidden(): void {}
    protected guarded(): void {}

    /** A public method with no parameters. */
    public ping(): void {}
}

/** A documented enum. */
export enum State {
    /** The ready state. */
    Ready,
}

/** A documented alias. */
export type Label = string

/** A documented function whose return tag is intentionally omitted.
 * @param value a value with a default
 */
export const withDefault = (value = "default"): string => value

/** A function with a destructured parameter.
 * @param options a
 */
export const destructured = ({ value }: { value: string }): string => value

/** This summary exists, but its parameter documentation does not. */
export const missingParameter = (value: string): string => value

/** This summary exists, but its optional parameter documentation does not. */
export const missingOptional = (optional?: string): string | undefined => optional

/** This summary exists, but its rest parameter documentation does not. */
export const missingRest = (...rest: number[]): number[] => rest

/** This summary exists, but its destructured parameter documentation does not. */
export const missingDestructured = ({ value }: { value: string }): string => value

/** This summary exists, but its generic documentation does not.
 * @param value the input value
 */
export const missingGeneric = <T>(value: T): T => value

/** API with an undocumented callback parameter. */
export interface MissingCallback {
    /** The callback itself is documented. */
    callback: (input: string) => void
}

export const missingSummary = true

/** @internal */
export function internalOnly(): void {}

function unexported(): void {}
void unexported

export { secondary } from "./secondary.js"
