const { v4: uuidv4 } = require('uuid');

/**
 * Canonical comment factory — used by both sessionManager and taskStore.
 * Produces a unified comment shape with threading and reactions support.
 */
function createComment({ text, author = 'user', parentId = null, mentions = [] } = {}) {
  return {
    id: uuidv4().slice(0, 8),
    text: text || '',
    author,
    createdAt: new Date().toISOString(),
    parentId: parentId || null,
    mentions: Array.isArray(mentions) ? mentions : [],
    reactions: []
  };
}

/**
 * Toggle a reaction on a comment (add if missing, remove if exists).
 * Uniqueness enforced by { emoji, author } pair.
 * @param {object} comment - Comment object with reactions array
 * @param {string} emoji - Emoji string
 * @param {string} author - Author identifier
 * @returns {object} The updated comment
 */
function addReactionToComment(comment, emoji, author) {
  if (!comment.reactions) comment.reactions = [];

  const idx = comment.reactions.findIndex(
    r => r.emoji === emoji && r.author === author
  );

  if (idx !== -1) {
    // Toggle off — remove existing reaction
    comment.reactions.splice(idx, 1);
  } else {
    // Toggle on — add new reaction
    comment.reactions.push({ emoji, author });
  }

  return comment;
}

module.exports = { createComment, addReactionToComment };
