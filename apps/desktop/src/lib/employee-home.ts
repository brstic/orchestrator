import type { Employee, Project } from '@orchestrator/contracts';

/**
 * Where an employee lives, the way a person thinks of it — and the way the hire form asks: **a folder of their
 * own**, or **a shared project** (where they get a worktree instead of a folder). The record says it with two
 * fields that mean different things together: somebody hired into a folder is on a project of their own, worked
 * in place in that folder, and `workingDir` repeats it.
 */

type Home = Pick<Employee, 'id' | 'projectId' | 'workingDir'>;
type Projects = Record<string, Pick<Project, 'id' | 'repoPath' | 'workspace' | 'ownerEmployeeId'> | undefined>;

/**
 * `shared`: the shared project they are on ('' when they own their folder). `folder`: the folder they live in
 * ('' when they are on a shared project and have none of their own).
 */
export function homeOf(e: Home, projects: Projects): { shared: string; folder: string } {
  const p = e.projectId ? projects[e.projectId] : undefined;
  // Their own: a project worked in place that is theirs or is the very folder they live in. (A project this
  // window has not been told about yet — it was made a moment ago — is taken by the folder they have.)
  const own = !!e.projectId && (!p ? !!e.workingDir : p.workspace === 'in_place' && (p.ownerEmployeeId === e.id || (!!e.workingDir && p.repoPath === e.workingDir)));
  if (!e.projectId || own) return { shared: '', folder: e.workingDir ?? p?.repoPath ?? '' };
  return { shared: e.projectId, folder: '' };
}

/**
 * What to ask of the office when the form says something else than the record: `folder` gives them that folder to
 * live in the way hiring does (it becomes their own project, or they join the one that already lives there);
 * `projectId` puts them on a shared project. Empty: nothing about where they live was changed.
 */
export function homePatch(e: Home, projects: Projects, form: { shared: string; folder: string }): { folder?: string; projectId?: string | null; workingDir?: null } {
  const now = homeOf(e, projects);
  const folder = form.folder.trim();
  if (form.shared) {
    if (form.shared === now.shared) return {};
    // On a shared project the worktree is their folder: one of their own is let go of.
    return { projectId: form.shared, ...(e.workingDir ? { workingDir: null } : {}) };
  }
  if (folder === now.folder && !now.shared) return {};
  if (folder) return { folder };
  // No shared project and no folder: they have nowhere to work until they are given one.
  return { ...(e.projectId ? { projectId: null } : {}), ...(e.workingDir ? { workingDir: null } : {}) };
}
