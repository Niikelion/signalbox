/** One option of a slash command. */
export interface CommandOption {
    /** Option name (lowercase). */
    name: string
    /** Help text shown in Discord. */
    description: string
    /** The option's value type. */
    type: "string" | "integer" | "boolean"
    /** Whether the user must supply it. Defaults to false. */
    required?: boolean
}

/** A slash command declaration. */
export interface CommandSpec {
    /** Command name (what the user types after `/`). */
    name: string
    /** Help text shown in Discord. */
    description: string
    /** The command's options, if any. */
    options?: CommandOption[]
}

// Discord application-command option types
const OPTION_TYPE = { string: 3, integer: 4, boolean: 5 } as const

/** The raw Discord application-command JSON produced by {@link toApplicationCommand}. */
export interface ApplicationCommand {
    name: string
    description: string
    options: { type: number; name: string; description: string; required: boolean }[]
}

/**
 * Convert a {@link CommandSpec} into the Discord application-command JSON used for registration.
 * @param spec the command declaration
 */
export const toApplicationCommand = (spec: CommandSpec): ApplicationCommand => ({
    name: spec.name,
    description: spec.description,
    options: (spec.options ?? []).map((option) => ({
        type: OPTION_TYPE[option.type],
        name: option.name,
        description: option.description,
        required: option.required ?? false,
    })),
})
