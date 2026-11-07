// Second lock on the review model's tools, independent of the agent file's
// permission list. It runs before every tool call and throws, which opencode
// reports to the model as a failed call, for anything the policy does not allow.
import { checkBashCommand, checkWebfetchUrl } from '../../.kinsho/.github/scripts/tool-policy.mjs';

export const KinshoGuard = async () => ({
  'tool.execute.before': async (input, output) => {
    if (input.tool === 'bash') {
      const check = checkBashCommand(output.args?.command);
      if (!check.ok) throw new Error(`Kinsho denied this command: ${check.reason}`);
    } else if (input.tool === 'webfetch') {
      const check = checkWebfetchUrl(output.args?.url);
      if (!check.ok) throw new Error(`Kinsho denied this fetch: ${check.reason}`);
    }
  }
});
