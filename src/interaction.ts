import {
  type APIApplicationCommandOption,
  type APIInteraction,
  type APIInteractionResponse,
  type APIMessageInteractionMetadata,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord-api-types/v10'
import {verifyRequestSignature} from './lib/ed25519.ts'
import {
  ApplicationCommandAutocompleteContext,
  ApplicationCommandContext,
  ContextMenuCommandContext,
  MessageComponentContext,
  ModalContext,
} from './context.ts'
import {associateBy} from '@std/collections/associate-by'
import type {Command, DefineHandler} from './types.ts'
import {commandSchema, userOrMessageCommandSchema} from './schema.ts'

const unknownCommand = (text?: string): APIInteractionResponse => {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: {
      content: text ?? 'Unknown command',
      flags: MessageFlags.Ephemeral,
    },
  }
}

const commandToAct = (command: RESTPostAPIApplicationCommandsJSONBody) => {
  const out: Record<string, any> = {}

  // out[command.name] ??= command // def
  out[command.name] ??= {} // def
  if (command.options) {
    out[command.name] = associateBy(command.options, (v) => v.name)

    for (const key in out[command.name]) {
      if (out[command.name][key].options) {
        // out[command.name][key] ??= out
        out[command.name][key] = associateBy(
          out[command.name][key].options as APIApplicationCommandOption[],
          (v) => v.name
        )

        for (const key2 in out[command.name][key]) {
          if (out[command.name][key][key2].options) {
            // out[command.name][key][key2] ??= {}
            out[command.name][key][key2] = associateBy(
              out[command.name][key][key2].options as APIApplicationCommandOption[],
              (v) => v.name
            )
          }
        }
      }
    }
  }
  // console.log(out)
  return out
}

const commandsInit = async (init: Command[]) => {
  const out: Record<string, any> = {}

  for (const {command, handler} of init) {
    const cAct = commandToAct(command) // to pretty obj
    // console.log(cAct)

    for (const key in handler) {
      const l0 = handler[key]
      if (typeof l0 === 'function') {
        // out[key] = await l0()
        out[key] = await l0(cAct[key])
      }
      if (typeof l0 === 'object') {
        out[key] ??= {}
        for (const key2 in l0) {
          const l1 = l0[key2]
          if (typeof l1 === 'function') {
            // out[key][key2] = await l1()
            out[key][key2] = await l1(cAct[key][key2])
          }
          if (typeof l1 === 'object') {
            out[key][key2] ??= {}
            for (const key3 in l1) {
              const l2 = l1[key3]
              if (typeof l2 === 'function') {
                // out[key][key2][key3] = await l2()
                out[key][key2][key3] = await l2(cAct[key][key2][key3])
              }
            }
          }
        }
      }
    }
  }

  return out
}

export const createHandler = async (commands: Command[]) => {
  const obj = (await commandsInit(commands)) as any

  return async (interaction: APIInteraction): Promise<APIInteractionResponse> => {
    if (interaction.type === InteractionType.Ping) {
      return {type: InteractionResponseType.Pong}
    }

    if (interaction.type === InteractionType.ApplicationCommand) {
      if (interaction.data.type === ApplicationCommandType.ChatInput) {
        const c = new ApplicationCommandContext(interaction, obj[interaction.data.name])

        if (!interaction.data.options) {
          return obj[interaction.data.name]?.command(c) ?? unknownCommand('command handler is undefined')
        } else {
          for (const option of interaction.data.options) {
            if (option.type === ApplicationCommandOptionType.Subcommand) {
              return (
                obj[interaction.data.name][option.name]?.command(c) ?? unknownCommand('command handler is undefined')
              )
            }

            if (option.type === ApplicationCommandOptionType.SubcommandGroup) {
              for (const subOption of option.options) {
                if (subOption.type === ApplicationCommandOptionType.Subcommand) {
                  return (
                    obj[interaction.data.name][option.name][subOption.name]?.command(c) ??
                    unknownCommand('command handler is undefined')
                  )
                }
              }
            }

            if (obj[interaction.data.name]?.command) {
              return obj[interaction.data.name]?.command(c) ?? unknownCommand('command handler is undefined')
            }
          }
        }
      }

      if (interaction.data.type === ApplicationCommandType.User) {
        const c = new ContextMenuCommandContext(obj[interaction.data.name])
        return obj[interaction.data.name]?.command(c) ?? unknownCommand('command handler is undefined')
      }

      if (interaction.data.type === ApplicationCommandType.Message) {
        const c = new ContextMenuCommandContext(obj[interaction.data.name])
        return obj[interaction.data.name]?.command(c) ?? unknownCommand('command handler is undefined')
      }
    }

    if (interaction.type === InteractionType.MessageComponent) {
      const c = new MessageComponentContext()
      const metadata = interaction.message?.interaction_metadata as
        | (APIMessageInteractionMetadata & {name: string})
        | undefined

      if (metadata?.type === InteractionType.ApplicationCommand) {
        const name = metadata?.name as string
        if (!name) return unknownCommand('Message Component interaction_metadata.name is undefined')
        const keys = name.split(' ', 3) // 'cmd sub-group sub'

        // find path
        // if (keys.length === 1) {
        //   return obj[keys[0]]?.messageComponent(c) ?? unknownCommand('messageComponent handler is undefined')
        // } else if (keys.length === 2) {
        //   return obj[keys[0]][keys[1]]?.messageComponent(c) ?? unknownCommand('messageComponent handler is undefined')
        // } else if (keys.length === 3) {
        //   return (
        //     obj[keys[0]][keys[1]][keys[2]]?.messageComponent(c) ??
        //     unknownCommand('messageComponent handler is undefined')
        //   )
        // }

        const handlers = keys.reduce((acc, key) => acc[key], obj) // obj[cmd][sub-group][sub]
        return handlers?.messageComponent(c) ?? unknownCommand('messageComponent handler is undefined')
      }

      return unknownCommand('messageComponent handler is undefined')
    }

    if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
      const c = new ApplicationCommandAutocompleteContext()
      return unknownCommand('commandAutocomplete handler is undefined')
    }

    if (interaction.type === InteractionType.ModalSubmit) {
      // Discord did not provide interaction metadata
      const c = new ModalContext(interaction.data)
      const metadata = interaction.message?.interaction_metadata as
        | (APIMessageInteractionMetadata & {name: string})
        | undefined

      if (metadata?.type === InteractionType.ApplicationCommand) {
        const name = metadata?.name as string
        if (!name) return unknownCommand('Message Component interaction_metadata.name is undefined')
        const keys = name.split(' ', 3) // 'cmd sub-group sub'

        const handlers = keys.reduce((acc, key) => acc[key], obj) // obj[cmd][sub-group][sub]
        return handlers?.modalSubmit(c) ?? unknownCommand('modalSubmit handler is undefined')
      }

      // best solution so far
      // fire all modalSubmit handler. if use ApplicationCommandContext.modal()
      for (const key1 in obj) {
        const l1 = obj[key1]
        if (l1?.modalSubmit) {
          const res = await l1.modalSubmit(c)
          if (res) return res
        } else {
          for (const key2 in l1) {
            const l2 = l1[key2]
            if (l2?.modalSubmit) {
              const res = await l2.modalSubmit(c)
              if (res) return res
            } else {
              for (const key3 in l2) {
                const l3 = l2[key3]
                if (l3?.modalSubmit) {
                  const res = await l3.modalSubmit(c)
                  if (res) return res
                }
              }
            }
          }
        }
      }

      return unknownCommand('modalSubmit handler is undefined')
    }

    return unknownCommand()
  }
}

/**
 * Example built on web standards
 *
 * @example
 * ```ts
 * import {importKeyRaw, discordInteraction} from '@maks11060/discord-interaction'
 * import {commands} from './commands.ts'
 *
 * const key = await importKeyRaw(Deno.env.get('CLIENT_PUBLIC_KEY')!)
 * const interaction = await discordInteraction(key, [])
 *
 * Deno.serve(req => {
 *   const uri = new URL(req.url)
 *   if (req.method === 'POST' && uri.pathname === '/interaction') {
 *     return interaction(req)
 *   }
 *   return new Response('404 Not found', {status: 404})
 * })
 * ```
 */
export const discordInteraction = async (
  key: CryptoKey,
  commands: Command[]
): Promise<(req: Request) => Promise<Response>> => {
  const handler = await createHandler(commands)

  return async (req: Request): Promise<Response> => {
    const invalid = await verifyRequestSignature(req, key)
    if (invalid) return invalid

    return Response.json(await handler(await req.json()))
  }
}

// ==========================================================================================
const validateCommand = <T extends RESTPostAPIApplicationCommandsJSONBody>(command: T): T => {
  if (command.type === undefined || command.type === ApplicationCommandType.ChatInput) {
    return commandSchema.passthrough().parse(command) as unknown as T
  } else if (command.type === ApplicationCommandType.Message || command.type === ApplicationCommandType.User) {
    return userOrMessageCommandSchema.passthrough().parse(command) as T
  }
  return commandSchema.passthrough().parse(command) as unknown as T
}

export const defineCommand = <const T extends RESTPostAPIApplicationCommandsJSONBody>(
  command: T
): {
  command: T
  createHandler(handler: DefineHandler<T>): {
    command: T
    handler: DefineHandler<T>
  }
} => {
  command = validateCommand(command)

  return {
    command,
    createHandler(handler: DefineHandler<T>) {
      return {command, handler}
    },
  }
}

// export const defineCommands = <const T extends RESTPostAPIApplicationCommandsJSONBody[]>(commands: T) => {
//   // command = validateCommand(command)
//   let command
//   return {
//     command,
//     createHandler(handler: DefineHandler<Unpack<T>>) {
//       return {command, handler}
//     },
//   }
// }
