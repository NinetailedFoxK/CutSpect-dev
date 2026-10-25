import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from './atomic-write';

/**
 * 最近项目索引（规格 11.1：应用 userData 中保存 recent-projects.json）。
 *
 * - 只保存“指向项目文件夹的索引”与展示用摘要；绝不复制项目正文。
 * - 允许保存平台绝对路径（这是本机设置，不随项目迁移）；
 *   项目内 project.json 才禁止写绝对路径。
 * - 读取时对损坏/缺失文件容错为空列表（索引可重建，不阻断应用启动）。
 * - 写入走原子替换，避免索引写一半损坏。
 */

export interface RecentEntry {
  projectId: string;
  /** 项目文件夹绝对路径（本机设置，规格 9.4 不随项目迁移）。 */
  folder: string;
  /** 展示名（冗余快照，打开时以 project.json 为准）。 */
  name: string;
  sourceOriginalName: string;
  durationMs: number | null;
  mediaId: string;
  /** 最近编辑时间（ISO 8601）。 */
  lastEditedAt: string;
}

function isRecentEntry(value: unknown): value is RecentEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.projectId === 'string' &&
    typeof entry.folder === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.sourceOriginalName === 'string' &&
    (entry.durationMs === null || typeof entry.durationMs === 'number') &&
    typeof entry.mediaId === 'string' &&
    typeof entry.lastEditedAt === 'string'
  );
}

export class RecentStore {
  constructor(private readonly filePath: string) {}

  /** 读取原始条目（未排序）；文件缺失/损坏返回空数组。 */
  async load(): Promise<RecentEntry[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(isRecentEntry);
    } catch {
      // 索引损坏：视为空（不删除文件，留待人工排查；下次写入覆盖）。
      return [];
    }
  }

  /** 按最近编辑时间降序返回（规格 2.2 默认排序）。 */
  async list(): Promise<RecentEntry[]> {
    const entries = await this.load();
    // ISO 8601 字典序即时间序；降序。
    return entries.sort((a, b) => (a.lastEditedAt < b.lastEditedAt ? 1 : -1));
  }

  async get(projectId: string): Promise<RecentEntry | null> {
    const entries = await this.load();
    return entries.find((entry) => entry.projectId === projectId) ?? null;
  }

  /** 新增或更新一条索引（按 projectId 去重）。 */
  async upsert(entry: RecentEntry): Promise<void> {
    const entries = await this.load();
    const index = entries.findIndex((item) => item.projectId === entry.projectId);
    if (index >= 0) {
      entries[index] = entry;
    } else {
      entries.push(entry);
    }
    await this.persist(entries);
  }

  /** 仅移除应用内索引，不删除磁盘项目（规格 2.2）；返回是否命中。 */
  async remove(projectId: string): Promise<boolean> {
    const entries = await this.load();
    const next = entries.filter((entry) => entry.projectId !== projectId);
    if (next.length === entries.length) {
      return false;
    }
    await this.persist(next);
    return true;
  }

  private async persist(entries: RecentEntry[]): Promise<void> {
    await writeFileAtomic(this.filePath, `${JSON.stringify(entries, null, 2)}\n`);
  }
}