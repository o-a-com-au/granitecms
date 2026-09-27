import { PromptCancelledError, createPrompter } from './prompts.ts';

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
