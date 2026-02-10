#!/usr/bin/env node
/**
 * Migration script: Merge tasks into sessions
 *
 * - Backs up data/tasks.json and data/sessions.json
 * - Merges task fields (stage, priority, description, etc.) into linked sessions
 * - Archives tasks.json
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const sessionsFile = path.join(dataDir, 'sessions.json');
const tasksFile = path.join(dataDir, 'tasks.json');
const backupDir = path.join(dataDir, 'backup-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));

function main() {
  console.log('=== Task → Session Migration ===\n');

  // Check if tasks file exists
  if (!fs.existsSync(tasksFile)) {
    console.log('No tasks.json found. Nothing to migrate.');
    return;
  }

  // Create backup directory
  fs.mkdirSync(backupDir, { recursive: true });
  console.log(`Backup directory: ${backupDir}`);

  // Backup files
  if (fs.existsSync(sessionsFile)) {
    fs.copyFileSync(sessionsFile, path.join(backupDir, 'sessions.json'));
    console.log('Backed up sessions.json');
  }
  fs.copyFileSync(tasksFile, path.join(backupDir, 'tasks.json'));
  console.log('Backed up tasks.json');

  // Load data
  let sessions = {};
  let tasks = {};

  try {
    if (fs.existsSync(sessionsFile)) {
      const sessionsData = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
      sessions = sessionsData.sessions || {};
    }
  } catch (err) {
    console.error('Error reading sessions.json:', err.message);
    return;
  }

  try {
    const tasksData = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
    tasks = tasksData.tasks || {};
  } catch (err) {
    console.error('Error reading tasks.json:', err.message);
    return;
  }

  const taskList = Object.values(tasks);
  console.log(`\nFound ${taskList.length} tasks and ${Object.keys(sessions).length} sessions`);

  let merged = 0;
  let orphaned = 0;

  for (const task of taskList) {
    // Find linked session by assignedSessionId
    const sessionId = task.assignedSessionId;
    const session = sessionId ? sessions[sessionId] : null;

    if (session) {
      // Merge task fields into session
      session.stage = task.stage || session.stage || 'todo';
      session.priority = task.priority || session.priority || 0;
      session.description = task.description || session.description || '';
      session.blockedBy = task.blockedBy || session.blockedBy || [];
      session.blocks = task.blocks || session.blocks || [];
      session.manuallyPlaced = task.manuallyPlaced || false;
      session.manualPlacedAt = task.manualPlacedAt || null;
      session.rejectionHistory = task.rejectionHistory || [];
      session.completedAt = task.completedAt || session.completedAt || null;
      session.updatedAt = task.updatedAt || session.updatedAt || null;
      session.comments = session.comments || [];

      // Remove linkedTaskId
      delete session.linkedTaskId;

      merged++;
      console.log(`  Merged task "${task.title}" → session "${session.name}" (stage: ${session.stage})`);
    } else {
      orphaned++;
      console.log(`  Orphan task "${task.title}" (no linked session) - discarded`);
    }
  }

  // Also clean linkedTaskId from sessions that weren't matched
  for (const session of Object.values(sessions)) {
    if (session.linkedTaskId) {
      delete session.linkedTaskId;
    }
    // Ensure stage fields exist
    if (!session.stage) session.stage = 'todo';
    if (!session.blockedBy) session.blockedBy = [];
    if (!session.blocks) session.blocks = [];
    if (!session.rejectionHistory) session.rejectionHistory = [];
    if (!session.comments) session.comments = [];
  }

  // Write updated sessions
  fs.writeFileSync(sessionsFile, JSON.stringify({ sessions }, null, 2), 'utf8');
  console.log(`\nWrote updated sessions.json`);

  // Archive tasks.json (rename)
  const archivedPath = path.join(dataDir, 'tasks.json.archived');
  fs.renameSync(tasksFile, archivedPath);
  console.log(`Archived tasks.json → tasks.json.archived`);

  console.log(`\n=== Migration Complete ===`);
  console.log(`  Merged: ${merged}`);
  console.log(`  Orphaned (discarded): ${orphaned}`);
  console.log(`  Backup: ${backupDir}`);
}

main();
