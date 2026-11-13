import { useState } from 'react';
import type { RadioSettings, RadioStation } from '@orchestrator/contracts';
import { Badge, Button, Field, Window, clock } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useAccess } from '../../lib/access.ts';
import { setPrefs, usePrefs } from '../../lib/prefs.ts';
import { playStation, retune, setRadioMuted, stopHiFi } from '../../lib/radio.ts';
import { useOffice } from '../../lib/store.ts';
import { act } from '../core.tsx';
import { registerPanel } from './index.tsx';

const EMPTY: RadioSettings = { stations: [], volume: 0.6, lastStationId: null };

/** The list of stations is the office's (its settings): only an owner changes it. */
function saveStations(stations: RadioStation[], ok?: string) {
  const current = useOffice.getState().settings?.radio ?? EMPTY;
  return act(() => api('PATCH', '/settings', { radio: { ...current, stations } }), ok);
}

/**
 * The office hi-fi: internet radio for the whole office. What is on is the office's — everyone in it hears it,
 * each from where their character stands. Owners and colleagues switch it; owners keep the list of stations;
 * everyone has their own volume and mute, on their own computer.
 */
function RadioPanel({ onClose }: { arg: string | null; onClose: () => void }) {
  const radio = useOffice((s) => s.settings?.radio ?? EMPTY);
  const hifi = useOffice((s) => s.hifi);
  const here = useOffice((s) => s.radio);
  const can = useAccess();
  const maySwitch = can.work(null);
  const muted = usePrefs((p) => p.prefs.radioMuted);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [info, setInfo] = useState('');
  const [volume, setVolume] = useState(() => usePrefs.getState().prefs.radioVolume);
  const valid = !!name.trim() && /^https?:\/\/\S+$/i.test(url.trim());

  const play = (s: RadioStation) => void act(() => playStation(s));
  const stop = () => void act(() => stopHiFi());
  const add = async () => {
    if (!valid) return;
    const station: RadioStation = { id: `st-${Date.now().toString(36)}`, name: name.trim(), url: url.trim(), nowPlayingUrl: info.trim() || null, page: null };
    const res = await saveStations([...radio.stations, station], `${station.name} added`);
    if (!res) return;
    setAdding(false);
    setName('');
    setUrl('');
    setInfo('');
    play(station);
  };
  // Removing the station that is on stops it for everyone: the office does that itself.
  const remove = (s: RadioStation) => void saveStations(radio.stations.filter((x) => x.id !== s.id), `${s.name} removed`);

  const by = hifi ? (hifi.by.id === (can.me?.id ?? 'owner') ? 'you' : hifi.by.name) : null;
  return (
    <Window kit title="Hi-fi" subtitle="Internet radio for the whole office — everyone who is in it hears what is on" onClose={onClose} width={640}>
      <div className="col" style={{ gap: 14 }}>
        <div className="card radio-now">
          <div className="radio-disc" data-on={!!hifi} aria-hidden>
            ♪
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="strong truncate">{hifi ? hifi.station.name : 'Nothing is playing'}</div>
            {hifi ? (
              <>
                <div className="small muted truncate">
                  Switched on by {by} at {clock(hifi.since)}
                  {here.nowPlaying ? ` · ${here.nowPlaying}` : ''}
                </div>
                <div className="small muted">
                  {muted ? (
                    'Muted on this computer — the others still hear it.'
                  ) : here.status === 'blocked' ? (
                    <button className="radio-link" onClick={retune}>
                      Your browser waits for a click before it plays sound — click here to listen.
                    </button>
                  ) : here.status === 'error' ? (
                    <>
                      <span className="bad">{here.error}</span> It is tried again by itself.{' '}
                      <button className="radio-link" onClick={retune}>
                        Try now
                      </button>
                    </>
                  ) : here.status === 'playing' ? (
                    'Playing on this computer.'
                  ) : (
                    'Tuning in…'
                  )}
                </div>
              </>
            ) : (
              <div className="small muted">{maySwitch ? 'Pick a station below: it plays for everyone in the office.' : 'When an owner or a colleague switches a station on, you hear it here too.'}</div>
            )}
          </div>
          {hifi && maySwitch && (
            <Button onClick={stop} title="Stop the hi-fi for everyone in the office">
              Stop for everyone
            </Button>
          )}
        </div>

        <div className="col" style={{ gap: 4 }}>
          <label className="row radio-volume">
            <span className="small muted">My volume</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              aria-label="My volume"
              onChange={(ev) => {
                const v = Number(ev.target.value);
                setVolume(v);
                // Heard at once; kept (written to this computer's preferences) when the slider is let go.
                usePrefs.setState((p) => ({ prefs: { ...p.prefs, radioVolume: v } }));
              }}
              onPointerUp={() => setPrefs({ radioVolume: volume })}
              onKeyUp={() => setPrefs({ radioVolume: volume })}
            />
            <span className="small mono muted" style={{ width: 34, textAlign: 'right' }}>
              {Math.round(volume * 100)}
            </span>
            <Button small variant={muted ? 'primary' : 'default'} onClick={() => setRadioMuted(!muted)} aria-pressed={muted} title={muted ? 'Hear the hi-fi on this computer again' : 'Switch it off on this computer only; it plays on for everyone else'}>
              {muted ? 'Unmute' : 'Mute'}
            </Button>
          </label>
          <div className="small faint">Your volume and mute are for this computer only. The hi-fi stands in the break room: the further your character is from it, the quieter you hear it — quietly even at the far end of the office.</div>
        </div>

        {maySwitch ? (
          <div className="col" style={{ gap: 4 }}>
            <div className="section-title">Stations</div>
            {radio.stations.length === 0 && <div className="small muted">{can.admin ? 'No stations yet. Add one below.' : 'No stations yet. An owner of the office can add one.'}</div>}
            {radio.stations.map((s) => {
              const on = hifi?.station.id === s.id;
              return (
                <div key={s.id} className={`radio-row ${on ? 'radio-row-on' : ''}`}>
                  <Button small variant={on ? 'default' : 'primary'} onClick={() => (on ? stop() : play(s))} aria-label={on ? `Stop ${s.name} for everyone` : `Play ${s.name} for everyone`} title={on ? 'Stop the hi-fi for everyone in the office' : 'Play it for everyone in the office'}>
                    {on ? '■ Stop' : '▶ Play'}
                  </Button>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="strong truncate">
                      {s.name} {on && <Badge tone="good">on air</Badge>}
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
                  {can.admin && (
                    <Button small variant="ghost" onClick={() => remove(s)} title={on ? 'Remove this station from the list; it stops playing for everyone' : 'Remove this station from the list'}>
                      Remove
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="small muted">You are visiting: owners and colleagues of this office choose the station.</div>
        )}

        {can.admin &&
          (adding ? (
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
            </div>
          ))}
        {maySwitch && !can.admin && <div className="small faint">Only an owner of the office adds or removes stations.</div>}
      </div>
    </Window>
  );
}

registerPanel('radio', RadioPanel);
