-- +goose Up
ALTER TABLE agent_runs
    ADD COLUMN dry_run boolean NOT NULL DEFAULT false,
    ADD COLUMN agent_config jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(agent_config) = 'object');

UPDATE agent_runs run
SET agent_config=jsonb_build_object(
    'id',agent.actor_id,'handle',actor.handle,'description',agent.description,
    'allowed_scopes',to_jsonb(agent.allowed_scopes),'llm_connection_id',agent.llm_connection_id,
    'endpoint_url',agent.endpoint_url,'external_data_sharing_approved',agent.external_data_sharing_approved,
    'max_output_tokens',agent.max_output_tokens,'max_tool_iterations',agent.max_tool_iterations
)
FROM agents agent
JOIN actors actor ON actor.org_id=agent.org_id AND actor.id=agent.actor_id
WHERE run.org_id=agent.org_id AND run.agent_id=agent.actor_id;

-- +goose Down
ALTER TABLE agent_runs
    DROP COLUMN IF EXISTS agent_config,
    DROP COLUMN IF EXISTS dry_run;
