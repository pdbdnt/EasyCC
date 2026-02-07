import { useState, useEffect } from 'react';

function TaskModal({ task, projects, sessions, onSave, onClose }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [project, setProject] = useState('');
  const [customProject, setCustomProject] = useState('');
  const [priority, setPriority] = useState(0);
  const [tags, setTags] = useState('');
  const [errors, setErrors] = useState({});

  const isEditing = !!task;

  useEffect(() => {
    if (task) {
      setTitle(task.title || '');
      setDescription(task.description || '');
      setProject(task.project || '');
      setPriority(task.priority || 0);
      setTags((task.tags || []).join(', '));
    } else {
      // Default to first project if available
      setProject(projects[0] || '');
    }
  }, [task, projects]);

  const validate = () => {
    const newErrors = {};

    if (!title.trim()) {
      newErrors.title = 'Title is required';
    }

    const finalProject = project === '__custom__' ? customProject.trim() : project;
    if (!finalProject) {
      newErrors.project = 'Project is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();

    if (!validate()) {
      return;
    }

    const finalProject = project === '__custom__' ? customProject.trim() : project;
    const tagList = tags
      .split(',')
      .map(t => t.trim())
      .filter(t => t.length > 0);

    onSave({
      title: title.trim(),
      description: description.trim(),
      project: finalProject,
      priority: parseInt(priority, 10),
      tags: tagList
    });
  };

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick}>
      <div className="modal task-modal">
        <div className="modal-header">
          <h2>{isEditing ? 'Edit Task' : 'New Task'}</h2>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body">
          <div className="form-group">
            <label htmlFor="task-title">Title *</label>
            <input
              id="task-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title"
              className={errors.title ? 'input-error' : ''}
              autoFocus
            />
            {errors.title && <span className="error-text">{errors.title}</span>}
          </div>

          <div className="form-group">
            <label htmlFor="task-description">Description</label>
            <textarea
              id="task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Task description (optional)"
              rows={4}
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="task-project">Project *</label>
              <select
                id="task-project"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                className={errors.project ? 'input-error' : ''}
              >
                <option value="">Select project...</option>
                {projects.map(p => (
                  <option key={p} value={p}>
                    {p.split(/[/\\]/).pop()}
                  </option>
                ))}
                <option value="__custom__">+ New project...</option>
              </select>
              {errors.project && <span className="error-text">{errors.project}</span>}
            </div>

            <div className="form-group">
              <label htmlFor="task-priority">Priority</label>
              <select
                id="task-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                <option value={0}>Low</option>
                <option value={1}>Medium</option>
                <option value={2}>High</option>
                <option value={3}>Critical</option>
              </select>
            </div>
          </div>

          {project === '__custom__' && (
            <div className="form-group">
              <label htmlFor="task-custom-project">New Project Path</label>
              <input
                id="task-custom-project"
                type="text"
                value={customProject}
                onChange={(e) => setCustomProject(e.target.value)}
                placeholder="C:\Users\denni\apps\my-project"
              />
            </div>
          )}

          <div className="form-group">
            <label htmlFor="task-tags">Tags</label>
            <input
              id="task-tags"
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="bug, feature, urgent (comma-separated)"
            />
          </div>

          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary">
              {isEditing ? 'Save Changes' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default TaskModal;
