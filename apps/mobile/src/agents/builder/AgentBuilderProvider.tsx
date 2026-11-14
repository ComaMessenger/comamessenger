import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  capabilitiesOf,
  draftOf,
  draftProblems,
  loosenedOf,
  publishBlockers,
  recipeOf,
  scopesFor,
  updateOf,
  type Agent,
  type AgentDraft,
  type AgentLlmConnection,
  type AgentRecipe,
  type AgentTrigger,
  type Capabilities,
  type Chat,
  type DraftProblem,
  type PublishBlocker,
} from "@comamessenger/core";
import { useTranslation } from "react-i18next";
import { cacheStorage } from "@/lib/database";
import { messageOf } from "@/lib/errors";
import { useSignedIn } from "@/session/SessionProvider";
import { useAutosave } from "@/settings/useAutosave";
import {
  agentKeys,
  useAgentAccess,
  useChats,
  useConnections,
  useRecipes,
  useTimezone,
  useTriggers,
  type AgentAccess,
} from "./data";

const fingerprint = (draft: AgentDraft) => JSON.stringify(updateOf(draft));

/** Edits not yet on the server, kept on the phone so going offline loses nothing. */
type LocalCopy = { draft: AgentDraft; base: string };
const localKey = (agentID: string) => `agent-draft:${agentID}`;

type Action = "" | "save" | "publish" | "pause" | "resume" | "rollback";

export type AgentBuilderValue = {
  agent: Agent;
  recipe: AgentRecipe | undefined;
  access: AgentAccess;
  chats: Chat[];
  connections: AgentLlmConnection[];
  timezone: string;
  draft: AgentDraft;
  /** Applies a change to the draft; it is saved a moment later. */
  update(
    change: Partial<AgentDraft> | ((draft: AgentDraft) => AgentDraft),
  ): void;
  capabilities: Capabilities;
  setCapabilities(value: Capabilities): void;
  problems: DraftProblem[];
  autosave: {
    phase: ReturnType<typeof useAutosave>["phase"];
    error: string;
    retry(): void;
  };
  /** The draft differs from the last copy the server has. */
  dirty: boolean;
  /** Edits made offline earlier were restored from the phone. */
  restored: "" | "applied" | "conflict";
  applyRestored(): void;
  dismissRestored(): void;
  triggers: UseQueryResult<AgentTrigger[]>;
  blockers: PublishBlocker[];
  /** Saves pending edits now; false when the draft cannot be saved. */
  flush(): Promise<boolean>;
  pending: Action;
  error: string;
  notice: string;
  clearMessages(): void;
  loosened: string[];
  cancelLoosened(): void;
  publish(acknowledge?: boolean): Promise<boolean>;
  pause(): Promise<boolean>;
  resume(): Promise<boolean>;
  rollback(versionID: string): Promise<boolean>;
  refetchAgents(): Promise<unknown>;
};

const BuilderContext = createContext<AgentBuilderValue | null>(null);

export function useAgentBuilder(): AgentBuilderValue {
  const value = useContext(BuilderContext);
  if (!value)
    throw new Error(
      "useAgentBuilder must be used inside <AgentBuilderProvider>",
    );
  return value;
}

/**
 * Builder state of one agent, shared by its step screens: the draft, its
 * autosave (as the settings screens do it, a moment after the last change),
 * a copy on the phone while it is not saved, and the publish. Mounted per
 * agent, so nothing typed for one agent reaches another.
 */
export function AgentBuilderProvider({
  agent,
  refetchAgents,
  children,
}: {
  agent: Agent;
  refetchAgents(): Promise<unknown>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { api } = useSignedIn();
  const queryClient = useQueryClient();
  const access = useAgentAccess();
  const chats = useChats();
  const connections = useConnections();
  const recipes = useRecipes();
  const timezone = useTimezone();
  const triggers = useTriggers(agent.id);
  const [draft, setDraft] = useState<AgentDraft>(() => draftOf(agent));
  const [restored, setRestored] = useState<"" | "applied" | "conflict">("");
  const conflict = useRef<AgentDraft | null>(null);
  const [pending, setPending] = useState<Action>("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loosened, setLoosened] = useState<string[]>([]);
  // The copy the server has; edits are compared with it.
  const server = useRef(fingerprint(draftOf(agent)));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const problems = useMemo(() => draftProblems(draft), [draft]);
  const dirty = fingerprint(draft) !== server.current;

  // Adopt a newer server copy unless the person has edits of their own.
  useEffect(() => {
    const incoming = draftOf(agent);
    const previous = server.current;
    server.current = fingerprint(incoming);
    setDraft((current) =>
      fingerprint(current) === previous ? incoming : current,
    );
  }, [agent]);

  // Edits left on the phone (offline, or the app closed before a save).
  useEffect(() => {
    let active = true;
    void cacheStorage
      .get<LocalCopy | null>(localKey(agent.id))
      .then((local) => {
        if (!active || !local) return;
        if (fingerprint(local.draft) === server.current) return;
        if (local.base === server.current) {
          setDraft(local.draft);
          setRestored("applied");
        } else {
          // The draft changed elsewhere since: ask before replacing it.
          conflict.current = local.draft;
          setRestored("conflict");
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [agent.id]);

  // Keep unsaved edits on the phone until the server has them.
  const base = useRef(server.current);
  useEffect(() => {
    if (!dirty) {
      base.current = server.current;
      void cacheStorage.set(localKey(agent.id), null).catch(() => undefined);
      return;
    }
    const timer = setTimeout(() => {
      void cacheStorage
        .set(localKey(agent.id), { draft, base: base.current })
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [agent.id, draft, dirty]);

  const adopt = useCallback(
    (updated: Agent) => {
      server.current = fingerprint(draftOf(updated));
      queryClient.setQueryData<Agent[]>(agentKeys.agents, (list) =>
        list?.map((item) => (item.id === updated.id ? updated : item)),
      );
    },
    [queryClient],
  );

  const save = useCallback(
    async (snapshot: AgentDraft) => {
      if (fingerprint(snapshot) === server.current) return snapshot;
      const updated = await api.updateAgent(agent.id, updateOf(snapshot));
      adopt(updated);
      return snapshot;
    },
    [adopt, agent.id, api],
  );

  const autosave = useAutosave<AgentDraft>({
    value: access.canBuild && problems.length === 0 ? draft : null,
    save,
    fingerprint,
    delay: 800,
  });

  async function flush(): Promise<boolean> {
    const current = draftRef.current;
    if (draftProblems(current).length > 0) {
      setError(t("agentPublishFixFields"));
      return false;
    }
    if (fingerprint(current) === server.current) return true;
    setPending("save");
    try {
      await save(current);
      return true;
    } catch (cause) {
      setError(messageOf(cause));
      return false;
    } finally {
      setPending("");
    }
  }

  async function run(
    action: Action,
    work: () => Promise<unknown>,
    success?: string,
  ): Promise<boolean> {
    setPending(action);
    setError("");
    setNotice("");
    try {
      await work();
      if (success) setNotice(t(success));
      return true;
    } catch (cause) {
      // Loosened confirmations are asked about, not shown as an error.
      if (!loosenedOf(cause)) setError(messageOf(cause));
      return false;
    } finally {
      setPending("");
    }
  }

  async function publishWith(acknowledge: boolean) {
    await save(draftRef.current);
    try {
      const published = await api.publishAgent(
        agent.id,
        acknowledge ? { acknowledge_loosened: true } : {},
      );
      adopt(published);
    } catch (cause) {
      const listed = loosenedOf(cause);
      if (listed) setLoosened(listed);
      throw cause;
    }
    setLoosened([]);
    await refetchAgents();
  }

  function update(
    change: Partial<AgentDraft> | ((draft: AgentDraft) => AgentDraft),
  ) {
    setDraft((current) =>
      typeof change === "function"
        ? change(current)
        : { ...current, ...change },
    );
  }

  const capabilities = useMemo(
    () => capabilitiesOf(draft.allowed_scopes),
    [draft.allowed_scopes],
  );

  const value: AgentBuilderValue = {
    agent,
    recipe: recipeOf(recipes.data, agent),
    access,
    chats,
    connections: connections.data ?? [],
    timezone,
    draft,
    update,
    capabilities,
    setCapabilities: (next) =>
      update((current) => ({
        ...current,
        allowed_scopes: scopesFor({
          capabilities: next,
          hasKnowledge: (current.knowledge_collection_ids ?? []).length > 0,
          current: current.allowed_scopes,
        }),
      })),
    problems,
    autosave: {
      phase: autosave.phase,
      error: autosave.error,
      retry: autosave.retry,
    },
    dirty,
    restored,
    applyRestored: () => {
      if (conflict.current) setDraft(conflict.current);
      conflict.current = null;
      setRestored("applied");
    },
    dismissRestored: () => {
      if (restored === "conflict") {
        conflict.current = null;
        void cacheStorage.set(localKey(agent.id), null).catch(() => undefined);
      }
      setRestored("");
    },
    triggers,
    blockers: publishBlockers(
      agent,
      draft,
      triggers.data,
      connections.data ?? [],
    ),
    flush,
    pending,
    error,
    notice,
    clearMessages: () => {
      setError("");
      setNotice("");
    },
    loosened,
    cancelLoosened: () => setLoosened([]),
    publish: async (acknowledge = false) => {
      if (draftProblems(draftRef.current).length > 0) {
        setError(t("agentPublishFixFields"));
        return false;
      }
      return run(
        "publish",
        () => publishWith(acknowledge),
        "agentPublishedNotice",
      );
    },
    pause: () =>
      run(
        "pause",
        async () => {
          adopt(await api.pauseAgent(agent.id));
          await refetchAgents();
        },
        "agentPausedNotice",
      ),
    resume: () =>
      run(
        "resume",
        async () => {
          adopt(await api.resumeAgent(agent.id));
          await refetchAgents();
        },
        "agentResumedNotice",
      ),
    rollback: (versionID) =>
      run(
        "rollback",
        async () => {
          const updated = await api.rollbackAgent(agent.id, versionID);
          adopt(updated);
          setDraft(draftOf(updated));
          await refetchAgents();
        },
        "agentRollbackNotice",
      ),
    refetchAgents,
  };

  return (
    <BuilderContext.Provider value={value}>{children}</BuilderContext.Provider>
  );
}
