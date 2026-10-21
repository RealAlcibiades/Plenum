// The spend warning and cap for a project's API-key models. The spend is a running total kept on the project record
// (project.spend = { usd, since }, saved in state.json). Each reply billed per token adds its estimated cost once, when it
// is made (accrueReply, called from runTurn and handleCompact in server.mjs). Clearing or compacting the chat, Edit, Undo
// and trimming the transcript do not change it. A project with no record starts from the transcript total as it stands
// the first time it is read or charged, and is dated then. Only a reply billed per token counts, so a subscription CLI is
// never capped. The limit itself is read from the project's settings (budgetOf in lib/projects.mjs).
import { budgetOf } from './projects.mjs';
import { totalUsage } from './pricing.mjs';

const isSpend = v => v !== null && typeof v === 'object' && Number.isFinite(v.usd) && v.usd >= 0 && typeof v.since === 'string' && !Number.isNaN(Date.parse(v.since));
// Kept to 1e-10 dollars, the precision lib/pricing.mjs keeps its own sums to, so many small replies do not drift.
const roundUsd = v => Math.round(v * 1e10) / 1e10;

// The project's spend record, { usd, since }. A project with none (or a damaged one) gets one now, from the transcript total
// as it stands. messages is the transcript that record starts from, so a caller adding a reply passes it before that reply is stored.
export function spendOf(project, messages) {
  if (!isSpend(project.spend)) project.spend = { usd: totalUsage(messages).api.dollars, since: new Date().toISOString() };
  return project.spend;
}

// Adds one reply's cost to the running total. Only a reply billed per token with a known dollar cost counts. A subscription
// CLI reply has no dollar cost, and a reply from a model with no published price, or with no token counts, adds nothing.
export function accrueReply(project, messages, usage) {
  if (usage?.billing !== 'api' || !Number.isFinite(usage.cost?.dollars)) return;
  const spend = spendOf(project, messages);
  spend.usd = roundUsd(spend.usd + usage.cost.dollars);
}

// Starts the running total again from nothing, dated now. The limits are kept.
export function resetSpend(project) {
  project.spend = { usd: 0, since: new Date().toISOString() };
  return project.spend;
}

// { spent, since, warnUsd, capUsd, level }. The level is 'cap' once the spend reaches the cap, 'warn' once it reaches the
// warning, and 'ok' before both.
export function budgetState(project, messages) {
  const { warnUsd, capUsd } = budgetOf(project);
  const { usd: spent, since } = spendOf(project, messages);
  const level = (capUsd && spent >= capUsd) ? 'cap' : (warnUsd && spent >= warnUsd) ? 'warn' : 'ok';
  return { spent, since, warnUsd, capUsd, level };
}

// Throws the refusal for a send when the project is at its cap and the model is billed per token (billing 'api').
// A subscription CLI (billing 'plan') and the offline model (billing null) are never refused here.
export function checkBudget(project, messages, billing) {
  if (billing !== 'api') return;
  const state = budgetState(project, messages);
  if (state.level !== 'cap') return;
  throw new Error(`Spend cap reached: this project has spent $${state.spent.toFixed(2)} of its $${state.capUsd.toFixed(2)} limit on API-key models. Raise or remove the limit in Spend limit (top bar), or use a subscription CLI model.`);
}
