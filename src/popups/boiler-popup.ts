import { css, html, nothing, svg } from 'lit';
import { state } from 'lit/decorators.js';
import { PopupContent } from './popup-base';
import { MODE_STYLE, boilerMode, pumpState, tempOf, zoneHeating, type BoilerEntities, type BoilerZone } from '../core/boiler';
import { fetchHistory, fetchStatistics, samples, type CompressedState } from '../core/history';
import { linePath } from '../core/chart';
import { fixed, numericState, time } from '../core/format';
import { startOfDay } from '../core/energy';
import { defineElement } from '../core/register';

const W = 1000;
const H = 200;

/** Boiler pop-up: live flow diagram, zones, outdoor and indoor, gas today, and the heating history. */
export class HomeViewBoilerPopup extends PopupContent {
  @state() private hours = 24;
  @state() private hist: Record<string, CompressedState[]> = {};
  @state() private gas: { heating?: number; hot_water?: number } = {};
  private loadedFor?: number;

  private get b(): BoilerEntities {
    return this.cfg as BoilerEntities;
  }

  popupTitle(): string {
    return this.cfg.name ?? 'Boiler';
  }

  popupSubtitle(): string {
    if (!this.hass) return '';
    return `${MODE_STYLE[boilerMode(this.hass, this.b)].label} · updated ${time(this.hass, new Date())}`;
  }

  protected updated(): void {
    if (this.hass && this.loadedFor !== this.hours) {
      this.loadedFor = this.hours;
      void this.loadHistory();
      void this.loadGas();
    }
  }

  private async loadHistory(): Promise<void> {
    const b = this.b;
    const ids = [
      b.flow_temp_entity,
      b.return_temp_entity,
      b.flow_target_entity,
      b.flame_entity,
      b.dhw_active_entity,
      ...(b.zones ?? []).map((z) => z.heat_call_entity ?? z.climate_entity),
    ].filter((x): x is string => !!x);
    try {
      this.hist = await fetchHistory(this.hass!, ids, this.hours, { attributes: true, ttlMs: 2 * 60_000 });
    } catch {
      this.hist = {};
    }
  }

  /** Today's gas for heating and hot water: the statistics change for meters, the state otherwise. */
  private async loadGas(): Promise<void> {
    const hass = this.hass!;
    const read = async (id?: string): Promise<number | undefined> => {
      const st = id ? hass.states[id] : undefined;
      if (!st) return undefined;
      const scale = ({ Wh: 0.001, MWh: 1000 } as Record<string, number>)[st.attributes.unit_of_measurement] ?? 1;
      if (['total', 'total_increasing'].includes(st.attributes.state_class)) {
        const now = new Date();
        const res = await fetchStatistics(hass, [id!], startOfDay(now), now, 'hour', ['change']).catch(() => ({}) as Record<string, never>);
        return (res[id!] ?? []).reduce((n, v) => n + (v.change ?? 0), 0) * scale;
      }
      const v = numericState(st);
      return v != null ? v * scale : undefined;
    };
    this.gas = { heating: await read(this.b.heating_energy_entity), hot_water: await read(this.b.hot_water_energy_entity) };
  }

  private diagram() {
    const hass = this.hass!;
    const b = this.b;
    const mode = boilerMode(hass, b);
    const pump = pumpState(b.pump_entity ? hass.states[b.pump_entity] : undefined);
    const flame = b.flame_entity ? hass.states[b.flame_entity]?.state === 'on' : mode === 'heating' || mode === 'hot_water';
    const flow = tempOf(hass, b.flow_temp_entity);
    const ret = tempOf(hass, b.return_temp_entity);
    const target = tempOf(hass, b.flow_target_entity);
    const dhw = tempOf(hass, b.dhw_temp_entity);
    const heatMoving = pump === 'on' || pump === 'overrun' || mode === 'heating';
    const dhwMoving = mode === 'hot_water';
    const speed = pump === 'overrun' ? '3.5s' : '1.2s';
    const pipe = (y: number, color: string, moving: boolean, reverse = false) => svg`
      <path d="M150 ${y} H560" stroke=${moving ? color : 'var(--_track)'} stroke-width="10" stroke-linecap="round"></path>
      ${moving
        ? svg`<path class="anim flow" d=${reverse ? `M560 ${y} H150` : `M150 ${y} H560`} stroke="rgba(255,255,255,.7)" stroke-width="3" stroke-dasharray="4 16" stroke-linecap="round" style="animation-duration:${speed}"></path>`
        : nothing}`;
    return html`<div class="panel diagram">
      ${svg`<svg viewBox="0 0 600 250" role="img" aria-label="Boiler flow diagram">
        <rect x="20" y="20" width="130" height="210" rx="22" fill="var(--_glass-hi)" stroke="var(--_track)" stroke-width="2"></rect>
        <rect x="42" y="42" width="86" height="40" rx="10" fill="rgba(0,0,0,.35)"></rect>
        <text x="85" y="70" text-anchor="middle" font-size="22" font-weight="700" fill="#7be8a2">${target != null && target > 0 ? `${Math.round(target)}°` : '--'}</text>
        <g transform="translate(85 150)">
          <path class=${flame ? 'anim flame' : ''} d="M0 -38c3 14 22 22 22 44a22 22 0 0 1-44 0c0-10 5-17 10-21 1 7 5 12 9 13-2-14 0-26 3-36z" fill=${flame ? '#FF8A3D' : 'var(--_track)'}></path>
        </g>
        ${pipe(70, '#FF8A3D', heatMoving)}
        ${pipe(130, '#4FB3FF', heatMoving, true)}
        ${b.dhw_temp_entity ? pipe(190, '#5AC8FA', dhwMoving) : nothing}
        <g transform="translate(470 100)">
          <circle r="22" fill="var(--_glass-hi)" stroke="var(--_track)" stroke-width="2"></circle>
          <path class=${pump !== 'off' ? 'anim spin' : ''} d="M0 -14 4 0 0 14 -4 0Z M-14 0 0 -4 14 0 0 4Z" fill=${pump !== 'off' ? 'var(--_ink)' : 'var(--_ink3)'} style="animation-duration:${speed}"></path>
        </g>
        <text x="575" y="76" text-anchor="end" font-size="20" font-weight="700" fill="var(--_ink)">${flow != null ? `${Math.round(flow)}°` : ''}</text>
        <text x="575" y="136" text-anchor="end" font-size="20" font-weight="700" fill="var(--_ink2)">${ret != null ? `${Math.round(ret)}°` : ''}</text>
        ${dhw != null ? svg`<text x="575" y="196" text-anchor="end" font-size="20" font-weight="700" fill="var(--_ink2)">${Math.round(dhw)}°</text>` : nothing}
      </svg>`}
      <div class="stats">
        <div><div class="cap">Flow</div><div class="stat">${flow != null ? `${Math.round(flow)}°` : '—'}</div></div>
        <div><div class="cap">Return</div><div class="stat">${ret != null ? `${Math.round(ret)}°` : '—'}</div></div>
        <div><div class="cap">ΔT</div><div class="stat">${flow != null && ret != null ? `${fixed(hass, flow - ret, 0)}°` : '—'}</div></div>
      </div>
    </div>`;
  }

  private zone(z: BoilerZone) {
    const hass = this.hass!;
    const st = hass.states[z.climate_entity];
    const heating = zoneHeating(hass, z);
    const cur = numericState(st, 'current_temperature');
    const tgt = numericState(st, 'temperature');
    const hum = z.humidity_entity ? numericState(hass.states[z.humidity_entity]) : numericState(st, 'current_humidity');
    return html`<div class="zone panel">
      <div class="zhead">
        <span class="round zi" style="background:${heating ? '#FF8A3D' : 'var(--_glass-hi)'};color:${heating ? '#fff' : 'var(--_ink2)'}"><ha-icon .icon=${z.icon ? (z.icon.includes(':') ? z.icon : `mdi:${z.icon === 'underfloor' ? 'heating-coil' : 'radiator'}`) : 'mdi:radiator'}></ha-icon></span>
        <div><div class="zname">${z.name ?? st?.attributes.friendly_name ?? z.climate_entity}</div><div class="sub" style="color:${heating ? 'var(--_heat-ink)' : 'var(--_ink2)'};font-weight:600">${heating ? 'Heating' : 'Idle'}</div></div>
      </div>
      <div class="zval">${cur != null ? `${fixed(hass, cur, 1)}°` : '—'}</div>
      <div class="sub">${tgt != null ? `Target ${fixed(hass, tgt, 1)}°` : ''}${hum != null ? ` · ${Math.round(hum)}%` : ''}</div>
    </div>`;
  }

  private history() {
    const b = this.b;
    const now = Date.now();
    const start = now - this.hours * 3_600_000;
    const x = (t: number) => ((t - start) / (now - start)) * W;
    const flow = samples(this.hist[b.flow_temp_entity ?? '']);
    const ret = samples(this.hist[b.return_temp_entity ?? '']);
    const tgt = samples(this.hist[b.flow_target_entity ?? '']);
    const all = [...flow, ...ret, ...tgt].map((p) => p[1]).filter((v) => v > 0);
    const lo = Math.min(20, ...all) - 2;
    const hi = Math.max(70, ...all) + 2;
    const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
    const step = (pts: Array<[number, number]>) => {
      const kept = pts.filter((p) => p[0] >= start);
      const before = pts.filter((p) => p[0] < start).pop();
      const seq = before ? [[start, before[1]] as [number, number], ...kept] : kept;
      if (seq.length) seq.push([now, seq[seq.length - 1][1]]);
      return linePath(seq.map(([t, v]) => [x(t), y(v)]));
    };
    const onSpans = (rows: CompressedState[] | undefined, isOn: (s: string, a?: Record<string, any>) => boolean) => {
      const spans: Array<[number, number]> = [];
      let open: number | undefined;
      let attrs: Record<string, any> | undefined;
      for (const r of rows ?? []) {
        if (r.a) attrs = r.a;
        const t = Math.max(start, r.lu * 1000);
        const active = isOn(r.s, r.a ?? attrs);
        if (active && open === undefined) open = t;
        if (!active && open !== undefined) {
          spans.push([open, t]);
          open = undefined;
        }
      }
      if (open !== undefined) spans.push([open, now]);
      return spans;
    };
    const binary = (s: string) => s === 'on';
    const lanes = [
      ...(b.zones ?? []).map((z) => ({
        name: z.name ?? this.hass!.states[z.climate_entity]?.attributes.friendly_name ?? z.climate_entity,
        color: '#FF8A3D',
        spans: z.heat_call_entity
          ? onSpans(this.hist[z.heat_call_entity], binary)
          : onSpans(this.hist[z.climate_entity], (_s, a) => a?.hvac_action === 'heating' || a?.hvac_action === 'preheating'),
      })),
      ...(b.flame_entity ? [{ name: 'Flame', color: '#FFB340', spans: onSpans(this.hist[b.flame_entity], binary) }] : []),
      ...(b.dhw_active_entity ? [{ name: 'Hot water', color: '#5AC8FA', spans: onSpans(this.hist[b.dhw_active_entity], binary) }] : []),
    ];
    const calls = lanes.slice(0, (b.zones ?? []).length).flatMap((l) => l.spans);
    const ticks = Array.from({ length: 5 }, (_, i) => start + ((now - start) * i) / 4);
    return html`<div class="panel hist">
      <div class="hhead">
        <h3 class="sec">Last ${this.hours} hours</h3>
        <div class="seg">${[6, 12, 24].map((h) => html`<button aria-pressed=${this.hours === h} @click=${() => (this.hours = h)}>${h}h</button>`)}</div>
      </div>
      <div class="legend">
        <span><i style="background:#FF8A3D"></i>Flow</span><span><i style="background:#4FB3FF"></i>Return</span>
        ${b.flow_target_entity ? html`<span><i class="dash"></i>Target</span>` : nothing}
        ${calls.length ? html`<span><i class="call"></i>Heat call</span>` : nothing}
      </div>
      ${svg`<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Flow and return temperature history">
        ${calls.map(([a, c]) => svg`<rect x=${x(a)} y="0" width=${Math.max(1, x(c) - x(a))} height=${H} fill="rgba(255,138,61,.12)"></rect>`)}
        ${b.flow_target_entity ? svg`<path d=${step(tgt)} fill="none" stroke="var(--_ink3)" stroke-width="1.6" stroke-dasharray="6 6" vector-effect="non-scaling-stroke"></path>` : nothing}
        <path d=${step(ret)} fill="none" stroke="#4FB3FF" stroke-width="2.5" vector-effect="non-scaling-stroke"></path>
        <path d=${step(flow)} fill="none" stroke="#FF8A3D" stroke-width="2.5" vector-effect="non-scaling-stroke"></path>
      </svg>`}
      <div class="lanes">
        ${lanes.map(
          (l) => html`<div class="lane"><span class="lname">${l.name}</span><div class="ltrack">${l.spans.map(
            ([a, c]) => html`<i style="left:${(x(a) / W) * 100}%;width:${Math.max(0.3, ((x(c) - x(a)) / W) * 100)}%;background:${l.color}"></i>`,
          )}</div></div>`,
        )}
      </div>
      <div class="ticks">${ticks.map((t, i) => html`<span>${i === 4 ? 'Now' : time(this.hass, new Date(t))}</span>`)}</div>
    </div>`;
  }

  render() {
    if (!this.hass) return nothing;
    const b = this.b;
    const hass = this.hass;
    const outdoor = b.outdoor_entity
      ? b.outdoor_entity.startsWith('weather.')
        ? numericState(hass.states[b.outdoor_entity], 'temperature')
        : tempOf(hass, b.outdoor_entity)
      : undefined;
    const indoor = tempOf(hass, b.indoor_entity);
    const gasTotal = (this.gas.heating ?? 0) + (this.gas.hot_water ?? 0);
    return html`
      <div class="grid">
        ${this.diagram()}
        <div class="side">
          ${(b.zones ?? []).length ? html`<div class="zones">${(b.zones ?? []).map((z) => this.zone(z))}</div>` : nothing}
          <div class="pair">
            ${outdoor != null || indoor != null
              ? html`<div class="panel small">
                  <div class="cap">Outside / inside</div>
                  <div class="stat">${outdoor != null ? `${fixed(hass, outdoor, 1)}°` : '—'} <span class="faint">/ ${indoor != null ? `${fixed(hass, indoor, 1)}°` : '—'}</span></div>
                </div>`
              : nothing}
            ${b.heating_energy_entity || b.hot_water_energy_entity
              ? html`<div class="panel small">
                  <div class="cap">Gas today</div>
                  <div class="stat">${fixed(hass, gasTotal, 1)} <span class="faint">kWh</span></div>
                  <div class="split">
                    <i style="flex:${this.gas.heating ?? 0} 1 0;background:#FF8A3D"></i><i style="flex:${this.gas.hot_water ?? 0} 1 0;background:#5AC8FA"></i>
                  </div>
                  <div class="sub tiny">Heating ${fixed(hass, this.gas.heating ?? 0, 1)} · Hot water ${fixed(hass, this.gas.hot_water ?? 0, 1)}</div>
                </div>`
              : nothing}
          </div>
        </div>
      </div>
      ${this.history()}
    `;
  }

  static styles = [
    ...PopupContent.styles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 20px;
      }
      .grid {
        display: grid;
        grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
        gap: 20px;
      }
      .diagram svg {
        width: 100%;
        height: auto;
        display: block;
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        margin-top: 10px;
      }
      .stat {
        font-size: 34px;
        font-weight: 600;
        letter-spacing: -0.02em;
      }
      .faint {
        color: var(--_ink3);
        font-size: 22px;
      }
      .side {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .zones {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 12px;
      }
      .zone {
        padding: 16px 18px;
      }
      .zhead {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .zi {
        width: 38px;
        height: 38px;
        cursor: default;
        --mdc-icon-size: 20px;
      }
      .zname {
        font-size: 17px;
        font-weight: 600;
      }
      .zval {
        font-size: 36px;
        font-weight: 600;
        letter-spacing: -0.02em;
        margin-top: 8px;
      }
      .pair {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
      }
      .small {
        padding: 16px 18px;
      }
      .split {
        display: flex;
        height: 10px;
        border-radius: 5px;
        overflow: hidden;
        gap: 2px;
        margin: 8px 0 6px;
        background: var(--_track);
      }
      .tiny {
        font-size: 15px;
      }
      .hhead {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .hhead .sec {
        margin: 0;
      }
      .legend {
        display: flex;
        gap: 18px;
        margin: 10px 0;
        font-size: 15px;
        font-weight: 600;
        color: var(--_ink2);
      }
      .legend span {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .legend i {
        width: 18px;
        height: 3px;
        border-radius: 2px;
      }
      .legend i.dash {
        height: 0;
        border-top: 2px dashed currentColor;
      }
      .legend i.call {
        height: 12px;
        background: rgba(255, 138, 61, 0.3);
      }
      .chart {
        width: 100%;
        height: 200px;
        display: block;
      }
      .lanes {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 10px;
      }
      .lane {
        display: grid;
        grid-template-columns: 120px minmax(0, 1fr);
        align-items: center;
        gap: 10px;
      }
      .lname {
        font-size: 15px;
        font-weight: 600;
        color: var(--_ink2);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ltrack {
        position: relative;
        height: 10px;
        border-radius: 5px;
        background: var(--_track);
      }
      .ltrack i {
        position: absolute;
        top: 0;
        bottom: 0;
        border-radius: 5px;
      }
      .ticks {
        display: flex;
        justify-content: space-between;
        margin: 8px 0 0 130px;
        font-size: 15px;
        font-weight: 600;
        color: var(--_ink3);
      }
      .flow {
        animation: flow linear infinite;
      }
      .flame {
        transform-origin: 0 10px;
        animation: flick 1.4s ease-in-out infinite;
      }
      .spin {
        animation: spin linear infinite;
      }
      @keyframes flow {
        to {
          stroke-dashoffset: -40;
        }
      }
      @keyframes flick {
        40% {
          transform: scale(1.06, 1.1);
        }
        70% {
          transform: scale(0.97);
        }
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      @media (max-width: 1000px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
    `,
  ];
}

defineElement('homeview-boiler-popup', HomeViewBoilerPopup);
