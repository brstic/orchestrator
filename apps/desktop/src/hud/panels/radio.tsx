import { useState } from 'react';
import type { RadioSettings, RadioStation } from '@orchestrator/contracts';
import { Badge, Button, Field, Window } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { playStation, setRadioVolume, stopRadio } from '../../lib/radio.ts';
import { useOffice } from '../../lib/store.ts';
import { act } from '../core.tsx';
import { registerPanel } from './index.tsx';

const EMPTY: RadioSettings = { stations: [], volume: 0.6, lastStationId: null };

function save(radio: Partial<RadioSettings>, ok?: string) {
  const current = useOffice.getState().settings?.radio ?? EMPTY;
  return act(() => api('PATCH', '/settings', { radio: { ...current, ...radio } }), ok);
}

/** The office hi-fi: internet radio stations that play in the owner's window. */
function RadioPanel({ onClose }: { arg: string | null; onClose: () => void }) {
  const radio = useOffice((s) => s.settings?.radio ?? EMPTY);
  const now = useOffice((s) => s.radio);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [info, setInfo] = useState('');
  const [volume, setVolume] = useState(radio.volume);
  const valid = !!name.trim() && /^https?:\/\/\S+$/i.test(url.trim());

  const play = (s: RadioStation) => {
    playStation(s);
    if (radio.lastStationId !== s.id) void save({ lastStationId: s.id });
  };
  const add = async () => {
    if (!valid) return;
    const station: RadioStation = { id: `st-${Date.now().toString(36)}`, name: name.trim(), url: url.trim(), nowPlayingUrl: info.trim() || null, page: null };
    const res = await save({ stations: [...radio.stations, station] }, `${station.name} added`);
    if (!res) return;
    setAdding(false);
    setName('');
    setUrl('');
    setInfo('');
    play(station);
  };
  const remove = (s: RadioStation) => {
    if (now.stationId === s.id) stopRadio();
    void save({ stations: radio.stations.filter((x) => x.id !== s.id) }, `${s.name} removed`);
  };

  return (
    <Window title="Hi-fi" subtitle="Internet radio for the office — it plays in this window only" onClose={onClose} width={640}>
      <div className="col" style={{ gap: 14 }}>
        <div className="card radio-now">
          <div className="radio-disc" data-on={now.status === 'playing'} aria-hidden>
            ♪
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="strong truncate">{now.stationId ? now.name : 'Nothing is playing'}</div>
            <div className="small muted truncate">
              {now.status === 'loading' ? 'Tuning in…' : now.status === 'error' ? <span className="bad">{now.error}</span> : now.status === 'playing' ? (now.nowPlaying ?? 'On air') : 'Pick a station below.'}
            </div>
          </div>
          {now.stationId && (
            <Button onClick={stopRadio} title="Stop the radio">
              Stop
            </Button>
          )}
        </div>

        <label className="row radio-volume">
          <span className="small muted">Volume</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            aria-label="Volume"
            onChange={(ev) => {
              const v = Number(ev.target.value);
              setVolume(v);
              setRadioVolume(v);
            }}
            onPointerUp={() => void save({ volume })}
            onKeyUp={() => void save({ volume })}
          />
          <span className="small mono muted" style={{ width: 34, textAlign: 'right' }}>
            {Math.round(volume * 100)}
          </span>
        </label>

        <div className="col" style={{ gap: 4 }}>
          <div className="section-title">Stations</div>
          {radio.stations.length === 0 && <div className="small muted">No stations yet. Add one below.</div>}
          {radio.stations.map((s) => {
            const on = now.stationId === s.id;
            return (
              <div key={s.id} className={`radio-row ${on ? 'radio-row-on' : ''}`}>
                <Button small variant={on ? 'default' : 'primary'} onClick={() => (on ? stopRadio() : play(s))} aria-label={on ? `Stop ${s.name}` : `Play ${s.name}`}>
                  {on ? '■ Stop' : '▶ Play'}
                </Button>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="strong truncate">
                    {s.name} {on && now.status === 'playing' && <Badge tone="good">on air</Badge>}
                  </div>
                  <div className="small faint mono truncate" title={s.url}>
                    {s.url}
                  </div>
                </div>
                {s.page && (
                  <a className="small" href={s.page} target="_blank" rel="noopener noreferrer">
                    site
                  </a>
                )}
                <Button small variant="ghost" onClick={() => remove(s)} title="Remove this station from the list">
                  Remove
                </Button>
              </div>
            );
          })}
        </div>

        {adding ? (
          <form
            className="col card"
            style={{ gap: 10 }}
            onSubmit={(ev) => {
              ev.preventDefault();
              void add();
            }}
          >
            <Field label="Name">
              <input value={name} onChange={(ev) => setName(ev.target.value)} placeholder="e.g. Radio Paradise" autoFocus />
            </Field>
            <Field label="Stream address" hint="The direct audio stream, not the station's web page — usually it ends in .mp3, .aac or /stream.">
              <input className="mono" value={url} onChange={(ev) => setUrl(ev.target.value)} placeholder="https://example.com/listen/radio.mp3" spellCheck={false} />
            </Field>
            <Field label="Now-playing address (optional)" hint="A JSON address that says what is on air, if the station has one (AzuraCast: …/api/nowplaying/<station>).">
              <input className="mono" value={info} onChange={(ev) => setInfo(ev.target.value)} placeholder="https://example.com/api/nowplaying/station" spellCheck={false} />
            </Field>
            <div className="row">
              <Button variant="primary" type="submit" disabled={!valid}>
                Add and play
              </Button>
              <Button variant="ghost" type="button" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="row">
            <Button onClick={() => setAdding(true)}>Add a station</Button>
            <span className="small faint">The hi-fi stands in the break room; its speakers move while something is playing.</span>
          </div>
        )}
      </div>
    </Window>
  );
}

registerPanel('radio', RadioPanel);
