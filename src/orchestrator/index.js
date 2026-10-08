// src/orchestrator/index.js - 军团/编排统一出口
export { Legion } from "./legion.js";
// 2026-10-07 全能超级 Agent: 并发治理 + 班组 + 专家名册
export { ConcurrencyGovernor, getGovernor, configureGovernor, resetGovernor, governorOptsFromConfig, GOVERNOR_DEFAULTS } from "./governor.js";
export { TEAMS, TOPOLOGIES, TEAM_ALIASES, resolveTeam, teamExperts, listTeams, teamCatalog, teamRiskProfile } from "./teams.js";
export { EXPERTS, HIGH_RISK_DOMAINS, resolveExpert, listExperts, expertCatalog, expertsByDomain } from "./experts.js";
// 2026-10-07 吸收自 TencentCloud/Octop: 专家包 / 人格模板 / 团队房间 / 会话键 scheme
export {
  ExpertPackCatalog, createPackCatalog, installPack, normalizeManifest, packRootsFromConfig,
  PACK_CATEGORIES, PACK_LIMITS, KNOWN_DOMAINS, builtinExpertsDir, userExpertsDir, pickLabel,
} from "./expert-pack.js";
export {
  MBTI_PROFILES, PERSONA_CODES, PERSONA_DIMENSIONS, BEHAVIOR_KEYS,
  getProfile, hasProfile, listProfiles, dimensionsOf, renderPersona, personaLine,
} from "./personas.js";
export { TeamRoom, TeamJobTracker, INBOX_STATUS, SPEAKER, composeFollowup, fallbackHostReply } from "./room.js";
export {
  SURFACES, SCOPES, sessionKeyFor, parseSessionKey, isSessionKey,
  normalizeSessionKey, withScope, roomKey, parseRoomKey,
} from "./session-key.js";
