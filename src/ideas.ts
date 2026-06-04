import fs from 'node:fs';
import path from 'node:path';
import { dataDir, mdDir, mdIndexPath } from './paths.js';

function ensureDirSync(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export interface Idea {
  id: string;
  title: string;
  text: string;
  tags?: string[];
  created: string;
  promoted?: boolean;
  promotedAt?: string;
  mdPath?: string;
}

const ideasPath = () => path.join(dataDir(), 'ideas.jsonl');
const ideasDir = () => path.join(mdDir(), 'ideas');

function ensureIdeasDir() {
  ensureDirSync(ideasDir());
}

export function loadIdeas(): Idea[] {
  const p = ideasPath();
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

export function saveIdeas(ideas: Idea[]) {
  const p = ideasPath();
  const content = ideas.map(i => JSON.stringify(i)).join('\n') + '\n';
  fs.writeFileSync(p, content);
}

export function createIdea(idea: Partial<Idea>): Idea {
  const ideas = loadIdeas();
  const newIdea: Idea = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    title: idea.title || 'Untitled Idea',
    text: idea.text || '',
    tags: idea.tags || [],
    created: new Date().toISOString(),
    promoted: false,
    ...idea,
  };
  ideas.unshift(newIdea);
  saveIdeas(ideas);
  return newIdea;
}

export function updateIdea(id: string, updates: Partial<Idea>): Idea | null {
  const ideas = loadIdeas();
  const idx = ideas.findIndex(i => i.id === id);
  if (idx === -1) return null;

  ideas[idx] = { ...ideas[idx], ...updates };
  saveIdeas(ideas);
  return ideas[idx];
}

export function deleteIdea(id: string) {
  const ideas = loadIdeas().filter(i => i.id !== id);
  saveIdeas(ideas);
}

export function promoteIdeaToMarkdown(id: string): { success: boolean; path?: string; message: string } {
  const ideas = loadIdeas();
  const idx = ideas.findIndex(i => i.id === id);
  if (idx === -1) return { success: false, message: 'Idea not found' };

  const idea = ideas[idx];
  ensureIdeasDir();

  const slug = idea.title.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'idea';

  const filename = `${slug}-${idea.id.slice(0, 6)}.md`;
  const filepath = path.join(ideasDir(), filename);

  const tagsLine = idea.tags && idea.tags.length > 0 
    ? `**Tags:** ${idea.tags.join(', ')}\n\n` 
    : '';

  const content = `# ${idea.title}

${tagsLine}${idea.text}

---

*Captured: ${new Date(idea.created).toLocaleString()}*
*Promoted to Brain: ${new Date().toISOString()}*
`;

  fs.writeFileSync(filepath, content);

  // Update idea
  idea.promoted = true;
  idea.promotedAt = new Date().toISOString();
  idea.mdPath = filepath;
  saveIdeas(ideas);

  // TODO: Update wiki index (will enhance in next step)
  // Integrate with wiki
  try {
    const logPath = path.join(mdDir(), 'log.md');
    const logEntry = `\n- Promoted idea: [${idea.title}](${filepath.replace(mdDir(), '')}) — ${new Date().toISOString().slice(0,10)}\n`;
    fs.appendFileSync(logPath, logEntry);
  } catch (_) {
    // non-critical
  }

  return {
    success: true,
    path: filepath,
    message: `Idea promoted and saved to ${filepath}`,
  };
}
