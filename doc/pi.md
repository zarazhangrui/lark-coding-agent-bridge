# Pi profiles

Pi 1.3 or later can be selected with `--agent pi` in the existing profile creation/onboarding flow. Install and sign into Pi first. Set `LARK_CHANNEL_PI_BIN` when its executable is outside PATH.

The adapter runs `pi --mode json` once per turn, sends the prompt over stdin, and stores native sessions under the bridge profile's `pi-sessions` directory. Consecutive messages resume the same exact UUID, isolated by the existing chat/workspace/policy session catalogue. `/new` starts a new session; `/resume` offers the current Pi session. Importing Pi's unrelated native history is not supported.

Pi owns provider authentication, model/thinking settings, and extensions. The bridge model picker follows Pi's default rather than listing another agent's models. Its native `agent_settled` event, followed by process exit, determines completion; `agent_end` alone can precede automatic retries.

Pi does not provide a built-in permission sandbox. This adapter rejects reduced-access runs rather than silently granting full access. Use it only with a trusted profile and trusted extensions, or provide an external sandbox. CLI execution uses argv, never a shell; resume accepts an exact UUID, never an arbitrary session path.

Personal profiles still default to owner/allowlist access for IM. To prevent document comments from being an additional entry point, set `comments: { "enabled": false }` in the profile; the default remains enabled for existing profiles. This option persists across config writes and is checked before comment fetching or agent execution. Meetings remain opt-in.

The initial adapter intentionally uses bounded per-turn processes. It does not add an RPC process pool, steering or background model changes.
