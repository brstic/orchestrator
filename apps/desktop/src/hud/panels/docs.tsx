import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Empty, Markdown, Window, timeAgo } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { loadDocs, useOffice, type DocFile, type DocListing } from '../../lib/store.ts';
import { registerPanel } from './index.tsx';

interface Doc {
  path: string;
  content: string;
  truncated: boolean;
  modifiedAt: string;
}

interface Node {
  name: string;
  path: string;
  file?: DocFile;
  children: Node[];
}

/** Flat relative paths → a folder tree, folders first. */
function tree(files: DocFile[]): Node {
  const root: Node = { name: '', path: '', children: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let at = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      let next = at.children.find((c) => c.name === part && !!c.file === (i === parts.length - 1));
      if (!next) {
        next = { name: part, path, children: [], ...(i === parts.length - 1 ? { file: f } : {}) };
        at.children.push(next);
      }
      at = next;
    });
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

/** The file someone most likely wants first. */
function firstChoice(files: DocFile[]): string | null {
  for (const want of ['CLAUDE.md', 'README.md', 'readme.md']) if (files.some((f) => f.path === want)) return want;
  return files.find((f) => !f.path.includes('/'))?.path ?? files[0]?.path ?? null;
}

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);

function Folder({ node, depth, open, toggle, selected, onSelect, filter }: { node: Node; depth: number; open: Set<string>; toggle: (p: string) => void; selected: string | null; onSelect: (p: string) => void; filter: string }) {
  return (
    <>
      {node.children.map((c) => {
        if (c.file) {
          if (filter && !c.path.toLowerCase().includes(filter)) return null;
          return (
            <button key={c.path} className={`doc-item ${selected === c.path ? 'doc-item-on' : ''}`} style={{ paddingLeft: 10 + depth * 14 }} onClick={() => onSelect(c.path)} title={c.path}>
              <span className="doc-ico" aria-hidden>
                ▤
              </span>
              <span className="truncate grow">{c.name}</span>
              {c.name === 'CLAUDE.md' && (
                <Badge tone="accent" title="Claude Code reads this file as project instructions">
                  instructions
                </Badge>
              )}
            </button>
          );
        }
        const isOpen = !!filter || open.has(c.path);
        return (
          <div key={c.path}>
            <button className="doc-item doc-folder" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => toggle(c.path)} aria-expanded={isOpen}>
              <span className="doc-ico" aria-hidden>
                {isOpen ? '▾' : '▸'}
              </span>
              <span className="truncate grow">{c.name}</span>
            </button>
            {isOpen && <Folder node={c} depth={depth + 1} open={open} toggle={toggle} selected={selected} onSelect={onSelect} filter={filter} />}
          </div>
        );
      })}
    </>
  );
}

/** An employee's documents: the Markdown files that live in their folder, read straight from their machine. */
function DocsPanel({ arg, onClose }: { arg: string | null; onClose: () => void }) {
  const employee = useOffice((s) => (arg ? s.employees[arg] : undefined));
  const cached = useOffice((s) => (arg ? s.docs[arg] : undefined));
  const [listing, setListing] = useState<DocListing | null>(cached ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [raw, setRaw] = useState(false);

  const refresh = () => {
    if (!arg) return;
    loadDocs(arg).then((l) => {
      setListing(l);
      setSelected((cur) => (cur && l.files.some((f) => f.path === cur) ? cur : firstChoice(l.files)));
    });
  };
  useEffect(refresh, [arg]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!arg || !selected) return void setDoc(null);
    let live = true;
    setError(null);
    api<Doc>('GET', `/employees/${arg}/docs/file?path=${encodeURIComponent(selected)}`)
      .then((d) => live && setDoc(d))
      .catch((e) => live && (setDoc(null), setError((e as Error).message)));
    return () => {
      live = false;
    };
  }, [arg, selected]);

  const root = useMemo(() => tree(listing?.files ?? []), [listing]);
  if (!employee) return null;
  const files = listing?.files ?? [];
  const meta = files.find((f) => f.path === selected);
  return (
    <Window
      title={`${employee.name}'s documents`}
      subtitle={listing?.root ? <span className="mono">{listing.root}</span> : 'The Markdown files in their folder'}
      onClose={onClose}
      width={1180}
      flush
      actions={
        <Button small onClick={refresh} title="Read the folder again">
          Refresh
        </Button>
      }
    >
      {!listing ? (
        <div className="doc-pad muted">Reading their folder…</div>
      ) : listing.unavailable ? (
        <div className="doc-pad">
          <Empty title="Not available">{listing.unavailable}</Empty>
        </div>
      ) : files.length === 0 ? (
        <div className="doc-pad">
          <Empty title="No documents here">There are no Markdown files in {employee.name}'s folder or its subfolders.</Empty>
        </div>
      ) : (
        <div className="doc-cols">
          <aside className="doc-side">
            {files.length > 8 && <input value={filter} onChange={(ev) => setFilter(ev.target.value)} placeholder="Filter files…" aria-label="Filter files" className="doc-filter" />}
            <div className="doc-tree">
              <Folder
                node={root}
                depth={0}
                open={open}
                toggle={(p) =>
                  setOpen((cur) => {
                    const next = new Set(cur);
                    if (next.has(p)) next.delete(p);
                    else next.add(p);
                    return next;
                  })
                }
                selected={selected}
                onSelect={setSelected}
                filter={filter.trim().toLowerCase()}
              />
            </div>
            <div className="small faint doc-count">
              {files.length} file{files.length === 1 ? '' : 's'}
              {listing.truncated ? ' (more exist; only the first are listed)' : ''}
            </div>
          </aside>
          <section className="doc-main">
            {selected && (
              <div className="doc-head">
                <span className="mono truncate grow" title={selected}>
                  {selected}
                </span>
                {meta && (
                  <span className="small faint">
                    {kb(meta.size)} · changed {timeAgo(meta.modifiedAt)}
                  </span>
                )}
                <Button small variant="ghost" onClick={() => setRaw((r) => !r)} title="Switch between the formatted document and its source">
                  {raw ? 'Formatted' : 'Source'}
                </Button>
              </div>
            )}
            <div className="doc-body">
              {error ? <div className="bad small">{error}</div> : !doc ? <div className="muted">Opening…</div> : raw ? <pre className="doc-raw">{doc.content}</pre> : <Markdown text={doc.content} />}
              {doc?.truncated && <div className="small faint">This file is longer than what is shown here.</div>}
            </div>
          </section>
        </div>
      )}
    </Window>
  );
}

registerPanel('docs', DocsPanel);
