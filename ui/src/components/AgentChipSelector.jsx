import { useMemo } from 'react';

function AgentChipSelector({ assignedAgentIds = [], allAgents = [], onAssign, onUnassign, disabled }) {
  const agentsById = useMemo(() => {
    const map = new Map();
    for (const agent of allAgents) {
      if (!agent.deletedAt) map.set(agent.id, agent);
    }
    return map;
  }, [allAgents]);

  const unassigned = useMemo(
    () => allAgents.filter(a => !a.deletedAt && !assignedAgentIds.includes(a.id)),
    [allAgents, assignedAgentIds]
  );

  return (
    <div className="agent-chip-selector">
      <div className="agent-chip-list">
        {assignedAgentIds.map(id => {
          const agent = agentsById.get(id);
          return (
            <span key={id} className="agent-chip">
              <span className={`agent-chip-dot ${agent?.activeSessionId ? 'online' : ''}`} />
              <span className="agent-chip-name">{agent?.name || id}</span>
              {!disabled && (
                <button
                  className="agent-chip-remove"
                  onClick={() => onUnassign?.(id)}
                  title={`Remove ${agent?.name || id}`}
                >
                  &times;
                </button>
              )}
            </span>
          );
        })}
        {assignedAgentIds.length === 0 && (
          <span className="agent-chip-empty">No agents assigned</span>
        )}
      </div>
      {!disabled && unassigned.length > 0 && (
        <select
          className="agent-chip-add"
          value=""
          onChange={e => { if (e.target.value) onAssign?.(e.target.value); }}
        >
          <option value="" disabled>Add agent...</option>
          {unassigned.map(agent => (
            <option key={agent.id} value={agent.id}>{agent.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}

export default AgentChipSelector;
