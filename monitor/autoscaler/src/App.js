import React, { useEffect, useMemo, useRef, useState } from "react";
import Slider from '@mui/material/Slider';
import "./App.css";

// Usa solo la config runtime nel browser
const API_BASE = (window.__RUNTIME_CONFIG__ && window.__RUNTIME_CONFIG__.BASE_PATH) || "";

// Utility: array di label -> dizionario
function labelsArrayToDict(labelsArray) {
  if (!Array.isArray(labelsArray)) return {};
  return labelsArray.reduce((acc, item) => {
    if (item.name && item.value !== undefined) acc[item.name] = item.value;
    return acc;
  }, {});
}

// Formatter RAM: byte -> Mi (IEC), stringa vuota se assente
function toMi(v) {
  if (v === "" || v === null || v === undefined) return "";
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "";
  const mi = Math.round(n / (1024 * 1024));
  return `${mi}Mi`;
}

// Repliche meter
function ReplicasMeter({ replicas, min, max, disabled }) {
  let rMax = Number(max) || 10;
  if (!max && replicas > 10) rMax = replicas;
  if (rMax < replicas) rMax = replicas;
  const marks = [];
  for (let i = 0; i <= rMax; i++) marks.push({ value: i });

  return (
    <div className={`replicas-meter ${disabled ? 'is-disabled' : ''}`} style={{display:'flex',alignItems:'center',minWidth:215}}>
      <span style={{width:22, textAlign:'right',fontSize:13, color:'#6c7895'}}>0</span>
      <Slider
        value={Number(replicas)}
        min={0}
        max={rMax}
        marks={marks}
        step={1}
        size="small"
        valueLabelDisplay="on"
        track={false}
        sx={{
          width: 140,
          mx: 2,
          '& .MuiSlider-mark': { bgcolor: '#bcd3e9', width: 2, height: 10 },
          '& .MuiSlider-valueLabel': { background: "#3a77c3", padding: '.1em .7em' }
        }}
        disabled
      />
      <span style={{width:22, textAlign:'left',fontSize:13, color:'#6c7895'}}>{rMax}</span>
    </div>
  );
}

function SkeletonRow() {
  return (
    <tr className="skeleton-row">
      <td><div className="sk sk-meter" /></td>
      <td><div className="sk sk-id" /></td>
      <td><div className="sk sk-name" /></td>
      <td><div className="sk sk-badge" /></td>
      <td><div className="sk sk-small" /></td>
      <td><div className="sk sk-small" /></td>
      <td><div className="sk sk-small" /></td>
      <td><div className="sk sk-small" /></td>
    </tr>
  );
}

function App() {
  // Stato caricamento e progress
  const [step, setStep] = useState("init-ui");       // init-ui | fetching | rendering | ready
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);

  // Dati
  const [services, setServices] = useState([]);
  const [visibleCount, setVisibleCount] = useState(0); // progressive reveal righe

  // UI
  const [sortCol, setSortCol] = useState("replicas");
  const [sortDir, setSortDir] = useState("desc");
  const [filters, setFilters] = useState({
    name: "",
    id: "",
    state: "",
    cpuLimit: "",
    ramLimit: "",
    cpuRes: "",
    ramRes: ""
  });

  const revealTimer = useRef(null);

  // Fetch periodico
  useEffect(() => {
    async function fetchServices() {
      try {
        setStep(prev => (prev === "init-ui" ? "fetching" : prev));
        const res = await fetch(`${API_BASE}/api/services`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const data = await res.json();

        const autoscaleSvcs = data.filter(s => {
          const labels = labelsArrayToDict(s.labels);
          return (String(labels["autoscale.enable"] || "")).toLowerCase() === "true";
        });

        // Mappatura + formattazione RAM
        const mapped = autoscaleSvcs.map(svc => {
          const labels = labelsArrayToDict(svc.labels);
          return {
            id: svc.id,
            name: svc.name || "",
            state: svc.state || "",
            replicas: svc.replicas,
            min: parseInt(labels["autoscale.min"] || 1, 10),
            max: parseInt(labels["autoscale.max"] || 10, 10),
            cpuLimit: svc.resources?.limit?.cpu ?? "",
            ramLimit: toMi(svc.resources?.limit?.memory ?? ""),
            cpuRes: svc.resources?.reservation?.cpu ?? "",
            ramRes: toMi(svc.resources?.reservation?.memory ?? "")
          };
        });

        setStep("rendering");
        setServices(mapped);
        setLastUpdated(new Date());
        setLoading(false);

        // Reveal progressivo: abilita n righe ogni 120ms
        if (revealTimer.current) clearInterval(revealTimer.current);
        setVisibleCount(0);
        const chunk = Math.max(1, Math.ceil((mapped.length || 1) / 10));
        revealTimer.current = setInterval(() => {
          setVisibleCount(prev => {
            const next = Math.min(mapped.length, prev + chunk);
            if (next >= mapped.length) {
              clearInterval(revealTimer.current);
              setStep("ready");
            }
            return next;
          });
        }, 120);
      } catch (e) {
        console.error("Failed to fetch services", e);
        // Mantieni loading UI ma mostra step esplicito
        setStep("fetching");
      }
    }

    // Primo caricamento
    setStep("init-ui");
    setLoading(true);
    fetchServices();

    // Poll ogni 30s come prima
    const intervalId = setInterval(fetchServices, 30000);
    return () => {
      clearInterval(intervalId);
      if (revealTimer.current) clearInterval(revealTimer.current);
    };
  }, []);

  // Derivati UI
  const fullData = useMemo(() => services, [services]);

  const filteredData = useMemo(() => {
    return fullData.filter(row =>
      (row.name.toLowerCase().includes(filters.name.toLowerCase())) &&
      (row.id.includes(filters.id)) &&
      (filters.state === "" || row.state === filters.state) &&
      (filters.cpuLimit === "" || String(row.cpuLimit) === filters.cpuLimit) &&
      (filters.ramLimit === "" || String(row.ramLimit) === filters.ramLimit) &&
      (filters.cpuRes === "" || String(row.cpuRes) === filters.cpuRes) &&
      (filters.ramRes === "" || String(row.ramRes) === filters.ramRes)
    );
  }, [fullData, filters]);

  const sortedData = useMemo(() => {
    const arr = [...filteredData];
    arr.sort((a, b) => {
      let av = a[sortCol], bv = b[sortCol];
      if (sortCol === "name") { av = av?.toLowerCase(); bv = bv?.toLowerCase(); }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return arr;
  }, [filteredData, sortCol, sortDir]);

  const rowsToRender = useMemo(() => {
    if (loading) return []; // skeleton separato
    if (!sortedData.length) return [];
    return sortedData.slice(0, Math.max(visibleCount, 0));
  }, [sortedData, visibleCount, loading]);

  const uniqueStates = useMemo(() => [...new Set(fullData.map(r => r.state).filter(Boolean))], [fullData]);
  const cpuLimits = useMemo(() => [...new Set(fullData.map(r => String(r.cpuLimit)).filter(v => v))], [fullData]);
  const ramLimits = useMemo(() => [...new Set(fullData.map(r => String(r.ramLimit)).filter(v => v))], [fullData]);
  const cpuResVals = useMemo(() => [...new Set(fullData.map(r => String(r.cpuRes)).filter(v => v))], [fullData]);
  const ramResVals = useMemo(() => [...new Set(fullData.map(r => String(r.ramRes)).filter(v => v))], [fullData]);

  // Footer status text
  const statusText = useMemo(() => {
    const t = lastUpdated ? new Date(lastUpdated).toLocaleString() : "—";
    const stepMap = {
      "init-ui": "Inizializzazione UI…",
      "fetching": "Recupero servizi…",
      "rendering": "Rendering dati…",
      "ready": "Aggiornato"
    };
    return `Aggiornato: ${t} • Stato: ${stepMap[step] || step}`;
  }, [lastUpdated, step]);

  const controlsDisabled = loading || step === "fetching" || step === "rendering";

  return (
    <div className="table-bg">
      {/* Header con bottone verso Swarm */}
      <div className="header-line">
        <h1 className="dashboard-title">Swarm Autoscaler Dashboard</h1>
        <a className="btn header-btn" href="/swarm">Vai a Swarm</a>
      </div>

      {/* Filtri: disabilitati durante init/fetch/render */}
      <div className={`filters-line ${controlsDisabled ? 'is-disabled' : ''}`}>
        <input className="filter-input" placeholder="Filtra Nome..." value={filters.name} onChange={e => setFilters({...filters, name: e.target.value})} disabled={controlsDisabled} />
        <input className="filter-input" placeholder="Filtra ID..." value={filters.id} onChange={e => setFilters({...filters, id: e.target.value})} disabled={controlsDisabled} />
        <select className="filter-select" value={filters.state} onChange={e => setFilters({...filters, state: e.target.value})} disabled={controlsDisabled}>
          <option value="">Stato (tutti)</option>
          {uniqueStates.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="filter-select" value={filters.cpuLimit} onChange={e => setFilters({...filters, cpuLimit: e.target.value})} disabled={controlsDisabled}>
          <option value="">CPU Limite (tutti)</option>
          {cpuLimits.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="filter-select" value={filters.ramLimit} onChange={e => setFilters({...filters, ramLimit: e.target.value})} disabled={controlsDisabled}>
          <option value="">RAM Limite (tutti)</option>
          {ramLimits.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="filter-select" value={filters.cpuRes} onChange={e => setFilters({...filters, cpuRes: e.target.value})} disabled={controlsDisabled}>
          <option value="">CPU Riservata (tutti)</option>
          {cpuResVals.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="filter-select" value={filters.ramRes} onChange={e => setFilters({...filters, ramRes: e.target.value})} disabled={controlsDisabled}>
          <option value="">RAM Riservata (tutti)</option>
          {ramResVals.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>

      {/* Tabella */}
      <div className="table-wrap">
        <table className={`modern-table ${loading ? 'is-loading' : ''}`}>
          <thead>
            <tr>
              <th onClick={() => {setSortCol("replicas"); setSortDir(sortDir === "asc" ? "desc" : "asc")}}>Repliche</th>
              <th onClick={() => {setSortCol("id"); setSortDir(sortDir === "asc" ? "desc" : "asc")}}>ID</th>
              <th onClick={() => {setSortCol("name"); setSortDir(sortDir === "asc" ? "desc" : "asc")}}>Nome</th>
              <th onClick={() => {setSortCol("state"); setSortDir(sortDir === "asc" ? "desc" : "asc")}}>Stato</th>
              <th>CPU Limite</th>
              <th>RAM Limite</th>
              <th>CPU Riservata</th>
              <th>RAM Riservata</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              // Skeleton 8 righe
              Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={`sk-${i}`} />)
            ) : (
              rowsToRender.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className="empty-state">Nessun servizio autoscalabile trovato.</div>
                  </td>
                </tr>
              ) : (
                rowsToRender.map(row => (
                  <tr key={row.id} className="row">
                    <td><ReplicasMeter replicas={row.replicas} min={row.min} max={row.max} disabled={false} /></td>
                    <td className="svc-id">{row.id}</td>
                    <td className="svc-name">{row.name}</td>
                    <td style={{ textAlign: "center" }}>
                      <span className={`status-badge ${row.state === "running" ? "badge-running" : (row.state === "degraded" ? "badge-degraded" : "badge-stopped")}`}>
                        {row.state.toUpperCase()}
                      </span>
                    </td>
                    <td style={{ textAlign: "center" }}>{row.cpuLimit}</td>
                    <td style={{ textAlign: "center" }}>{row.ramLimit}</td>
                    <td style={{ textAlign: "center" }}>{row.cpuRes}</td>
                    <td style={{ textAlign: "center" }}>{row.ramRes}</td>
                  </tr>
                ))
              )
            )}
          </tbody>
        </table>
      </div>

      {/* Footer stato aggiornamento */}
      <footer className="dashboard-footer">
        <span>{statusText}</span>
      </footer>
    </div>
  );
}

export default App;
