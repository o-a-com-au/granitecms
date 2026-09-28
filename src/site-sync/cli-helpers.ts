import { PromptCancelledError, createPrompter, type Choice } from './prompts.ts';

export interface SyncArgs {
  positional: string[];
  flags: Set<string>;
  token: string | undefined;
}

export function parseSyncArgs(argv: string[]): SyncArgs {
  const tokenFlag = argv.indexOf('--token');
  const token = tokenFlag === -1 ? undefined : argv[tokenFlag + 1];
  const rest = argv.filter((_, index) => tokenFlag === -1 || (index !== tokenFlag && index !== tokenFlag + 1));
  return {
    positional: rest.filter((arg) => !arg.startsWith('--')),
    flags: new Set(rest.filter((arg) => arg.startsWith('--'))),
    token,
  };
}

// One prompter for the whole run (see createPrompter). Questions and
// warnings go to stderr, so stdout carries only the result.
const prompter = createPrompter(process.stdin, process.stderr);

export async function ask(question: string, hidden = false): Promise<string> {
  try {
    return await prompter.ask(question, { hidden });
  } catch (error) {
    if (error instanceof PromptCancelledError) {
      process.exit(130);
    }
    throw error;
  }
}

export const TOKEN_HELP =
  'The token is the live site\'s API token (the same one the admin uses), with the "content" and "media" scopes.';

// CMS_TOKEN and --token still work for scripts, but either leaves the
// token in shell history; asked for, it goes nowhere.
export async function resolveToken(args: SyncArgs, siteUrl: string): Promise<string> {
  const token = args.token ?? process.env.CMS_TOKEN ?? (await ask(`API token for ${siteUrl} (hidden): `, true));
  if (!token) {
    console.error('No token entered.');
    console.error(TOKEN_HELP);
    process.exit(1);
  }
  return token;
}

export interface PartOption {
  available: boolean;
  // What it holds ("3 pages changed"), or why it isn't available.
  detail: string;
  // Ticked to start with.
  checked: boolean;
}

// Which of content and theme to include. --content and/or --theme on
// the command line decide it outright (for scripts); otherwise a
// checkbox list, showing what each part holds or why it can't be chosen.
export async function chooseParts(
  args: SyncArgs,
  verb: 'pull' | 'push',
  options: { content: PartOption; theme: PartOption },
): Promise<{ content: boolean; theme: boolean }> {
  const flagged = { content: args.flags.has('--content'), theme: args.flags.has('--theme') };
  if (flagged.content || flagged.theme) {
    for (const part of ['content', 'theme'] as const) {
      if (flagged[part] && !options[part].available) {
        console.error(`Can't ${verb} the ${part}: ${options[part].detail}.`);
        process.exit(1);
      }
    }
    return flagged;
  }
  const choices: Choice[] = [
    { name: 'content', label: 'Content', detail: options.content.detail, checked: options.content.checked, disabled: !options.content.available },
    { name: 'theme', label: 'Theme', detail: options.theme.detail, checked: options.theme.checked, disabled: !options.theme.available },
  ];
  try {
    const chosen = new Set(await prompter.choose(`What do you want to ${verb}?`, choices));
    return { content: chosen.has('content'), theme: chosen.has('theme') };
  } catch (error) {
    if (error instanceof PromptCancelledError) {
      process.exit(130);
    }
    throw error;
  }
}
