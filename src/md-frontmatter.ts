/**
 * Handles generating correct YAML frontmatter for compiled Markdown files
 * to support first-class integration with standard note-taking apps like Obsidian and Logseq.
 */

export interface WikiFrontmatter {
  title: string;
  tags?: string[];
  aliases?: string[];
  confidence_score?: number;
  superseded_by?: string;
  date_created?: string;
  memory_tier?: string;
}

export function generateFrontmatter(data: WikiFrontmatter, targetApp: 'obsidian' | 'logseq' | 'standard' = 'standard'): string {
  let yaml = '---\n';

  // Core metadata shared across systems
  if (data.title) yaml += `title: "${data.title}"\n`;
  if (data.date_created) yaml += `date: ${data.date_created}\n`;
  
  // Specific memory tiering logic
  if (data.confidence_score !== undefined) {
    yaml += `confidence: ${data.confidence_score.toFixed(3)}\n`;
  }
  if (data.memory_tier) {
    yaml += `tier: ${data.memory_tier}\n`;
  }
  if (data.superseded_by) {
    yaml += `superseded_by: "[[${data.superseded_by}]]"\n`;
  }

  // App-specific formats
  if (data.tags && data.tags.length > 0) {
    if (targetApp === 'logseq') {
      yaml += `tags: ${data.tags.join(', ')}\n`;
    } else {
      yaml += `tags:\n${data.tags.map(t => `  - ${t}`).join('\n')}\n`;
    }
  }

  if (targetApp === 'obsidian' && data.aliases && data.aliases.length > 0) {
    yaml += `aliases:\n${data.aliases.map(a => `  - ${a}`).join('\n')}\n`;
  } else if (targetApp === 'logseq' && data.aliases && data.aliases.length > 0) {
    yaml += `alias:: ${data.aliases.join(', ')}\n`;
  }
  
  yaml += '---\n';
  return yaml;
}

/**
 * Strips frontmatter from existing markdown if we need to parse its pure content
 */
export function removeFrontmatter(markdown: string): string {
  if (markdown.startsWith('---\n')) {
    const endMatch = markdown.indexOf('\n---\n', 4);
    if (endMatch !== -1) {
      return markdown.slice(endMatch + 5);
    }
  }
  return markdown;
}
