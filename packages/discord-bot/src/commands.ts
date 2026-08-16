export interface CommandOption {
    name: string
    description: string
    type: "string" | "integer" | "boolean"
    required?: boolean
}

export interface CommandSpec {
    name: string
    description: string
    options?: CommandOption[]
}

// Discord application-command option types
const OPTION_TYPE = { string: 3, integer: 4, boolean: 5 } as const

export interface ApplicationCommand {
    name: string
    description: string
    options: { type: number; name: string; description: string; required: boolean }[]
}

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
