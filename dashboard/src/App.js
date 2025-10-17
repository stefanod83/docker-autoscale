import React, { useEffect, useState } from "react";
import Slider from '@mui/material/Slider';
import "./App.css";

const API_BASE = window.__APP_CONFIG__?.API_BASE || process.env.REACT_APP_API_BASE || "";

function labelsArrayToDict(labelsArray) {
  if (!Array.isArray(labelsArray)) return {};
  return labelsArray.reduce((acc, item) => {
    if (item.name && item.value !== undefined) acc[item.name] = item.value;
    return acc;
  }, {});
}

// Repliche meter
function ReplicasMeter({ replicas, min, max }) {
  let rMax = Number(max) || 10;
  if (!max && replicas > 10) rMax = replicas;
  if (rMax < replicas) rMax = replicas;
  const marks = [];
  for (let i = 0; i <= rMax; i++) marks.push({ value: i });

  return (
    <div style={{display:'flex',alignItems:'center',minWidth:215}}>
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

function App() {
  const [services, setServices] = useState([]);
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

  useEffect(() => {
    async function fetchServices() {
      try {
        const res = await fetch(`${API_BASE}/api/services`);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const data = await res.json();

        const autoscaleSvcs = data.filter(s => {
          const labels = labelsArrayToDict(s.labels);
          return (String(labels["autoscale.enable"] || "")).toLowerCase() === "true";
        });

        setServices(autoscaleSvcs);
      } catch (e) {
        console.error("Failed to fetch services", e);
      }
    }
    fetchServices();
    const intervalId = setInterval(fetchServices, 30000);
    return () => clearInterval(intervalId);
  }, []);

  const fullData = services.map(svc => {
    const labels = labelsArrayToDict(svc.labels);
    return {
      id: svc.id,
      name: svc.name || "",
      state: svc.state || "",
      replicas: svc.replicas,
      min: parseInt(labels["autoscale.min"] || 1, 10),
      max: parseInt(labels["autoscale.max"] || 10, 10),
      cpuLimit: svc.resources?.limit?.cpu ?? "",
      ramLimit: svc.resources?.limit?.memory ?? "",
      cpuRes: svc.resources?.reservation?.cpu ?? "",
      ramRes: svc.resources?.reservation?.memory ?? ""
    };
  });

  const filteredData = fullData.filter(row =>
    (row.name.toLowerCase().includes(filters.name.toLowerCase())) &&
    (row.id.includes(filters.id)) &&
    (filters.state === "" || row.state === filters.state) &&
    (filters.cpuLimit === "" || String(row.cpuLimit) === filters.cpuLimit) &&
    (filters.ramLimit === "" || String(row.ramLimit) === filters.ramLimit) &&
    (filters.cpuRes === "" || String(row.cpuRes) === filters.cpuRes) &&
    (filters.ramRes === "" || String(row.ramRes) === filters.ramRes)
  );

  const sortedData = filteredData.sort((a, b) => {
    let av = a[sortCol], bv = b[sortCol];
    if (sortCol === "name") { av = av?.toLowerCase(); bv = bv?.toLowerCase(); }
    if (av < bv) return sortDir === "asc" ? -1 : 1;
    if (av > bv) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  const uniqueStates = [...new Set(fullData.map(r => r.state).filter(Boolean))];
  const cpuLimits = [...new Set(fullData.map(r => String(r.cpuLimit)).filter(v => v))];
  const ramLimits = [...new Set(fullData.map(r => String(r.ramLimit)).filter(v => v))];
  const cpuResVals = [...new Set(fullData.map(r => String(r.cpuRes)).filter(v => v))];
  const ramResVals = [...new Set(fullData.map(r => String(r.ramRes)).filter(v => v))];

  return (
    <div className="table-bg">
      <h1 className="dashboard-title">Swarm Autoscaler Dashboard</h1>
      <div className="filters-line">
        <input className="filter-input" placeholder="Filtra Nome..." value={filters.name} onChange={e => setFilters({...filters, name: e.target.value})} />
        <input className="filter-input" placeholder="Filtra ID..." value={filters.id} onChange={e => setFilters({...filters, id: e.target.value})} />
        <select className="filter-select" value={filters.state} onChange={e => setFilters({...filters, state: e.target.value})}>
          <option value="">Stato (tutti)</option>
          {uniqueStates.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="filter-select" value={filters.cpuLimit} onChange={e => setFilters({...filters, cpuLimit: e.target.value})}>
          <option value="">CPU Limite (tutti)</option>
          {cpuLimits.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="filter-select" value={filters.ramLimit} onChange={e => setFilters({...filters, ramLimit: e.target.value})}>
          <option value="">RAM Limite (tutti)</option>
          {ramLimits.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="filter-select" value={filters.cpuRes} onChange={e => setFilters({...filters, cpuRes: e.target.value})}>
          <option value="">CPU Riservata (tutti)</option>
          {cpuResVals.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="filter-select" value={filters.ramRes} onChange={e => setFilters({...filters, ramRes: e.target.value})}>
          <option value="">RAM Riservata (tutti)</option>
          {ramResVals.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
      <div className="table-wrap">
        <table className="modern-table">
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
            {sortedData.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <div className="empty-state">Nessun servizio autoscalabile trovato.</div>
                </td>
              </tr>
            ) : (
              sortedData.map(row => (
                <tr key={row.id}>
                  <td><ReplicasMeter replicas={row.replicas} min={row.min} max={row.max} /></td>
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
            )}
          </tbody>
        </table>
      </div>
      <footer className="dashboard-footer">
        <span>Powered by Swarm Autoscaler • {new Date().toLocaleDateString()}</span>
      </footer>
    </div>
  );
}

export default App;
