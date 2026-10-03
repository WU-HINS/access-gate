/**
 * 全部表的汇总入口（由 tools/extract-doc-schema.ts 生成）。
 *
 * 消费方只经 `allTables` / `normalizeTables(allTables)` 使用，不要 import 具体表文件。
 */
import { collectTables, type TableDecl } from '../dsl.ts';
import { users, identities, sessions, emailRules, inviteCodes, developers, sites, pluginInstances, devInvitations, platformSettings } from './identity.ts';
import { plugins, pluginConfigs, pluginGrants, pluginBindings, pluginFacts, pluginInvocations, pluginStorage, llmCache, pluginEndpoints, pluginUiContributions, pluginPackages } from './plugin.ts';
import { policies, policyVersions, policyAssignments } from './policy.ts';
import { userPolicyState, evaluations, actionsLog, checkinEntitlements, checkinRecords } from './execution.ts';
import { externalSubjects, providerSyncState, secrets, oidcSigningKeys, verifyClients, verifyChallenges, verifyAssertions, verifyNonces, oauthClients, oauthCodes, oauthRefreshTokens, pluginTokens, oidcProviders, oidcLoginTransactions } from './integration.ts';
import { auditLog, jobs, eventOutbox, deadLetters, quotaCounters } from './ops.ts';

export const allTables: readonly TableDecl[] = collectTables([
  users,
  identities,
  sessions,
  emailRules,
  inviteCodes,
  developers,
  sites,
  pluginInstances,
  devInvitations,
  platformSettings,
  plugins,
  pluginConfigs,
  pluginGrants,
  pluginBindings,
  pluginFacts,
  pluginInvocations,
  pluginStorage,
  llmCache,
  pluginEndpoints,
  pluginUiContributions,
  pluginPackages,
  policies,
  policyVersions,
  policyAssignments,
  userPolicyState,
  evaluations,
  actionsLog,
  checkinEntitlements,
  checkinRecords,
  externalSubjects,
  providerSyncState,
  secrets,
  oidcSigningKeys,
  verifyClients,
  verifyChallenges,
  verifyAssertions,
  verifyNonces,
  oauthClients,
  oauthCodes,
  oauthRefreshTokens,
  pluginTokens,
  oidcProviders,
  oidcLoginTransactions,
  auditLog,
  jobs,
  eventOutbox,
  deadLetters,
  quotaCounters,
]);

