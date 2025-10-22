### Swarm Autoscaler + Dashboard

Autoscaler e Dashboard per Docker Swarm basati su Docker Engine API, con socket proxy a permessi minimi, autoscaling guidato da label, normalizzazione CPU per core allocati, scale‑down “graceful” con pre‑stop, notifiche email con batching, admin API di test e integrazione Traefik.
Il design separa proxy read‑only globali per metriche e proxy manager‑only per update, mantenendo il principio del minimo privilegio e la compatibilità con manager/worker eterogenei.

![UX Table v3.1.png](monitor/screen/Autoscaler/UX%20Table%20v3.1.png)
![Matrix v1.2.png](monitor/screen/Swarm/Matrix%20v1.2.png)

### Caratteristiche

- Autoscaling per servizio abilitato da label con soglie CPU/MEM, min/max repliche, cooldown e disattivazione opzionale dello scale‑down per workload che non possono spegnersi.
- Lettura metriche per replica via /containers/{id}/stats con stream=false, calcolo CPU conforme alla CLI e normalizzazione per core allocati da NanoCPUs/Quota/Period/Cpuset, con cap al 100% per replica.
- Scale‑down “graceful” opzionale con exec pre‑stop e stop controllato, eseguito in background per non bloccare il loop, quindi update delle repliche solo a drain completato.
- Notifiche email per eventi di scaling con batching su finestra configurabile, invio immediato per errori critici e endpoint amministrativo /api/test‑email per prove di connettività SMTP.
- Avvio “robusto” con attesa configurabile STARTUP_PROXY_WAIT per la disponibilità dei proxy, evitando falsi errori in bootstrap e riducendo alert rumorosi.
- Dashboard web con due viste: Autoscale, che visualizza e monitora stato repliche, limiti e risorse per i soli servizi marcati per autoscaling, e Swarm, che mostra l’assegnazione dei task ai nodi e l’utilizzo delle risorse a livello cluster.
- Sicurezza: docker‑socket‑proxy con sezioni API granulari, proxy RO globali per GET e proxy RW vincolato ai manager per mutate, filesystem bind in sola lettura con tmpfs nei path richiesti da HAProxy.


### Architettura

- dsproxy_ro: proxy read‑only deploy “global” con endpoint_mode=dnsrr su tutti i nodi, abilita GET per servizi, task, containers e info, e viene interrogato dall’autoscaler mappando NodeID→proxy per raccogliere le stats dalla sorgente corretta.
- dsproxy_rw: proxy manager‑only, singola replica con POST abilitato, usato dall’autoscaler per aggiornare le repliche con /services/{id}/update e per leggere /services su nodo manager.
- Autoscaler: singola replica su manager, ciclo di riconciliazione con cooldown, decisione ±1 replica per volta, pre‑stop asincrono opzionale, normalizzazione CPU e notifiche email con batching.
- Dashboard: frontend React con backend Node che interroga la Docker Engine API del manager per alimentare le viste Autoscale e Swarm; usa MANAGER_API_URL per puntare al proxy manager e calcola stati running/degraded/stopped, risorse e assegnazioni dei task con Traefik per l’esposizione esterna.


### Requisiti

- Docker Swarm attivo e almeno 1 manager disponibile per /services e mutate dello stato di cluster via Engine API.
- Overlay network interna per collegare autoscaler, dashboard e proxy, più rete esterna per Traefik se necessario.
- docker‑socket‑proxy deployato con variabili per abilitare solo le sezioni richieste da ciascun servizio (GET per RO, POST+SERVICES/CONTAINERS/TASKS per RW).
- File config SMTP in YAML via Swarm config o, preferibilmente, credenziali in Swarm secrets, con path montato nel container autoscaler.


### Deploy di riferimento (estratto)

```yaml
version: "3.8"

configs:
  autoscaler-haproxy:
    external: true

secrets:
  autoscaler-smtp:
    external: true

networks:
  internal:
    driver: overlay
    attachable: true
  traefik-net:
    external: true
  egress:
    external: true

services:
  dsproxy_ro:
    image: tecnativa/docker-socket-proxy:latest
    networks: [internal]
    deploy:
      mode: global
      endpoint_mode: dnsrr
      placement:
        constraints:
          - node.platform.os == linux
    environment:
      CONTAINERS: "1"
      SERVICES: "1"
      TASKS: "1"
      NODES: "1"
      INFO: "1"
      SYSTEM: "1"
      VERSION: "1"
      EVENTS: "1"
      PING: "1"
      POST: "0"
      LOG_LEVEL: "${PROXY_LOG_LEVEL:-info}"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    configs:
      - source: autoscaler-haproxy
        target: /usr/local/etc/haproxy/haproxy.cfg.template
        mode: 0444
    tmpfs:
      - /run
      - /tmp
      - /usr/local/etc/haproxy

  dsproxy_rw:
    image: tecnativa/docker-socket-proxy:latest
    networks: [internal]
    deploy:
      mode: replicated
      replicas: 1
      placement:
        constraints:
          - node.role == manager
    environment:
      CONTAINERS: "1"
      SERVICES: "1"
      TASKS: "1"
      INFO: "1"
      SYSTEM: "1"
      VERSION: "1"
      EVENTS: "1"
      PING: "1"
      POST: "1"
      LOG_LEVEL: "${PROXY_LOG_LEVEL:-info}"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    configs:
      - source: autoscaler-haproxy
        target: /usr/local/etc/haproxy/haproxy.cfg.template
        mode: 0444
    tmpfs:
      - /run
      - /tmp
      - /usr/local/etc/haproxy

  autoscaler:
    image: your-registry/swarm-autoscaler:latest
    networks: [internal, egress]
    expose: ["9090"]
    environment:
      READONLY_PROXY_DNS: "tasks.dsproxy_ro"
      READONLY_PROXY_PORT: "2375"
      MANAGER_PROXY_HOST: "http://dsproxy_rw:2375"
      POLL_INTERVAL: "15"
      DEFAULT_COOLDOWN: "120"
      LABEL_PREFIX: "autoscale"
      LOG_LEVEL: "${AUTOSCALER_LOG_LEVEL:-info}"
      DEFAULT_MIN_REPLICAS: "1"
      DEFAULT_MAX_REPLICAS: "50"
      SMTP_CONFIG_PATH: "/config/smtp.yml"
      ADMIN_API_PORT: "9090"
      STARTUP_PROXY_WAIT: "60"
    secrets:
      - source: autoscaler-smtp
        target: /config/smtp.yml
        mode: 0444
    deploy:
      mode: replicated
      replicas: 1
      placement:
        constraints:
          - node.role == manager
      restart_policy:
        condition: any

  dashboard:
    image: your-registry/swarm-autoscaler-dashboard:latest
    networks: [internal, traefik-net]
    environment:
      MANAGER_API_URL: "http://dsproxy_rw:2375"
      DOCKER_API_VERSION: "v1.49"
      LOG_LEVEL: "${DASHBOARD_LOG_LEVEL:-info}"
    expose: ["8080"]
    deploy:
      labels:
        traefik.enable: 'true'
        traefik.http.routers.autoscaler.rule: Host(`autoscaler.example.local`)
        traefik.http.routers.autoscaler.entrypoints: https
        traefik.http.routers.autoscaler.tls: 'true'
        traefik.http.services.autoscaler.loadbalancer.server.port: '8080'
      replicas: 1
      placement:
        constraints:
          - node.role == manager
```


### Variabili d’ambiente – Autoscaler

- READONLY_PROXY_DNS: nome DNS RR del servizio dsproxy_ro, default tasks.dsproxy_ro, usato per risolvere i proxy per nodo.
- READONLY_PROXY_PORT: porta del proxy RO, default 2375.
- MANAGER_PROXY_HOST: base URL del proxy manager per mutate/letture cluster, es. http://dsproxy_rw:2375.
- POLL_INTERVAL: intervallo del loop di riconciliazione in secondi, default 15.
- DEFAULT_COOLDOWN: cooldown di default in secondi se non sovrascritto da label, default 120.
- LABEL_PREFIX: prefisso label, default autoscale, consente namespace flessibile.
- LOG_LEVEL: livello log (debug, info, warning, error), default info.
- DEFAULT_MIN_REPLICAS/DEFAULT_MAX_REPLICAS: limiti globali di sicurezza per min/max se assenti nelle label, default 1/50.
- SMTP_CONFIG_PATH: path del file YAML di configurazione SMTP montato via config/secret, default /config/smtp.yml.
- ADMIN_API_PORT: porta API amministrativa per /api/test‑email, default 9090.
- STARTUP_PROXY_WAIT: attesa massima in secondi per la disponibilità dei proxy all’avvio, default 60.


### Variabili d’ambiente – Dashboard

- MANAGER_API_URL: URL del proxy manager usato per tutte le chiamate della dashboard (Autoscale e Swarm), es. http://dsproxy_rw:2375, richiede un demone manager dietro al proxy.
- DOCKER_API_VERSION: versione dell’Engine API (es. v1.49 o v1.51) per coerenza con il daemon del cluster, verificabile con /version.
- LOG_LEVEL: livello log locale della dashboard server, default info.

Nota: DOCKER_API_URL è stato sostituito da MANAGER_API_URL nel container delle dashboard per rendere esplicita la necessità di puntare sempre al manager.

### Label supportate (prefisso di default: autoscale)

- enable=true|false: abilita/disabilita il monitoraggio e l’autoscaling del servizio, richiesto per l’inclusione  .
- cpu.max / cpu.min: soglie percentuali per scale‑up/scale‑down sulla CPU normalizzata per replica, es. 75 / 20.
- mem.max / mem.min: soglie percentuali per la memoria, es. 80 / 15.
- min / max: limiti inferiori/superiori di repliche, es. 2 / 10.
- cooldown: cooldown minimo tra operazioni di scaling, in secondi, es. 120.
- scale_down.enable=true|false: abilita/disabilita lo scale‑down per workload che non devono spegnersi, default true  .
- pre_stop.cmd: comando di drain eseguito nel container selezionato prima dello stop, es. sh -c 'graceful-stop \&\& wait-active-jobs'.
- pre_stop.timeout: timeout del pre_stop in secondi, default 600, al termine del quale il downscale è annullato.
- stop.timeout: timeout passato allo stop del container in secondi, default 30.
- notify.email.enable=true|false: abilita le notifiche email per quel servizio, di default segue la config globale SMTP  .
- notify.email.to=email1,email2: destinatari specifici per quel servizio, se non impostati usa to_default del config.


### Configurazione SMTP (YAML)

```yaml
enabled: true
smtp:
  host: "smtp.example.com"
  port: 587
  starttls: true
  username: "autoscaler@example.com"
  password: "SET-IN-SECRET"
from: "Swarm Autoscaler <autoscaler@example.com>"
to_default:
  - "devops@example.com"
  - "noc@example.com"
subject_prefix: "[Swarm Autoscaler]"
batch_window_seconds: 300
max_batch_events: 100
```


### API amministrativa (Autoscaler)

- /api/test-email GET/POST: parametri to (lista CSV), subject, body, invia una mail immediata usando la configurazione SMTP caricata, utile per test di reachability, porta, STARTTLS e credenziali.
- Risposta JSON: { ok: true, to: [...] } su successo; error dettagliato su failure con HTTP 4xx/5xx per facilitare il troubleshooting.


### API dashboard

Questa sezione descrive le API esposte dal container delle dashboard, distinguendo fra la vista Autoscale e la vista Swarm, entrambe alimentate dalla Docker Engine API del manager indicata da MANAGER_API_URL.

#### Autoscale

- GET /api/autoscale/services: restituisce l’elenco dei servizi con label di autoscaling, lo stato running/degraded/stopped, repliche desiderate/attive e limiti/prenotazioni se presenti.
- GET /api/autoscale/services/{id}: dettaglio di un singolo servizio con aggregazioni su repliche, limiti e soglie derivate dalle label e dallo spec del servizio.
- GET /api/autoscale/tasks?serviceId={id}: elenco dei task/repliche correnti del servizio, con mapping verso i nodi e principali metriche disponibili per la vista.

Note: gli endpoint Autoscale filtrano per label prefix configurato e utilizzano la versione di Engine API definita in DOCKER_API_VERSION per compatibilità di campo.

#### Swarm

- GET /api/swarm/nodes: elenco nodi con ruolo, stato, disponibilità e risorse allocabili per la visualizzazione aggregata a livello cluster.
- GET /api/swarm/services: elenco servizi con desiderate/attive e principali metadati utili alla mappa di allocazione.
- GET /api/swarm/tasks?serviceId={id}: task correnti per servizio con nodo assegnatario, stato, desired-state e informazioni di piazzamento.
- GET /api/swarm/allocations: proiezione aggregata “service→node→tasks” per rappresentare l’assegnazione dei task ai nodi e l’impegno risorse per ciascun nodo.

Note: tutti gli endpoint Swarm effettuano solo letture verso il manager indicato da MANAGER_API_URL e non eseguono mutate; eventuali errori “not a manager” indicano configurazione errata della variabile o del proxy.

### Come funziona

- Scoperta servizi: GET /services con filters={"label":["autoscale.enable=true"]} e status=true su manager, con fallback a filtrare lato server se il daemon non accetta filters in quella versione.
- Stato/repliche: ServiceStatus.RunningTasks/DesiredTasks è usato quando disponibile, altrimenti fallback a /tasks?filters={"service":["id"],"desired-state":["running"]} per contare le repliche effettive.
- Statistiche: GET /containers/{id}/stats?stream=false per un campione con precpu_stats, poi formula \$ CPU_{raw}=\frac{\Delta total}{\Delta system}\times online\_cpus\times 100 \$ come da implementazioni note.
- Normalizzazione CPU: divisione per i core allocati alla replica da NanoCPUs, Quota/Period o Cpuset conteggiato, con cap a 100% per replica per evitare scale‑up ingiustificati su workload multi‑CPU.
- Decisione: scale‑up se media CPU>cpu.max o MEM>mem.max, scale‑down se CPU<cpu.min e MEM<mem.min, con step ±1 e rispetto di min/max e cooldown.
- Graceful down: se pre_stop.cmd impostato, exec create/start e polling fino a ExitCode==0 o timeout, stop del container con timeout e update delle repliche, tutto in background per non bloccare il loop.
- Startup wait: all’avvio si attende fino a STARTUP_PROXY_WAIT che /_ping sul manager e almeno un proxy RO /info risultino raggiungibili, altrimenti si invia una mail d’errore con template “ERROR” e si termina.


### Sicurezza e best practice

- Proxy RO: abilita solo GET strettamente necessarie, evita POST, non esporlo fuori dalla rete overlay, e usa endpoint_mode=dnsrr per avere tutte le repliche nel DNS.
- Proxy RW: una sola replica vincolata a manager con POST e sezioni SERVICES/CONTAINERS/TASKS attive, non esporlo esternamente, usato solo dall’autoscaler.
- HAProxy nel proxy: bind IPv4, timeouts client/connect/server e directory tmpfs per /usr/local/etc/haproxy e /run, mantenendo il root FS in sola lettura, se abilitato.
- Manager only: /services e mutate di cluster vanno sempre a un demone manager per evitare 503 “not a manager” e letture incomplete di stato.


### Esempi di label per servizio

```yaml
deploy:
  labels:
    - "autoscale.enable=true"
    - "autoscale.cpu.max=75"
    - "autoscale.cpu.min=20"
    - "autoscale.mem.max=80"
    - "autoscale.mem.min=15"
    - "autoscale.min=2"
    - "autoscale.max=10"
    - "autoscale.cooldown=120"
    - "autoscale.scale_down.enable=true"
    - "autoscale.pre_stop.cmd=sh -c 'graceful-stop && wait-active-jobs'"
    - "autoscale.pre_stop.timeout=600"
    - "autoscale.stop.timeout=45"
    - "autoscale.notify.email.enable=true"
    - "autoscale.notify.email.to=team-a@example.com,ops@example.com"
```


### Esempi di risorse in Compose

```yaml
deploy:
  resources:
    limits:
      cpus: "0.50"
      memory: 512M
    reservations:
      cpus: "0.25"
      memory: 128M
```


### Comandi utili

- Scaling manuale: docker service scale myservice=5 per impostare il numero di repliche desiderate in modo rapido.
- Update con repliche: docker service update --replicas 5 myservice per un update puntuale coerente con la semantica di rollout.


### Troubleshooting

- 400 invalid filter su /services: evitare doppio URL‑encode dei filters, usare JSON puro nel querystring o filtrare lato server se necessario per versioni più vecchie.
- 503 not a manager: MANAGER_API_URL della dashboard o MANAGER_PROXY_HOST dell’autoscaler devono puntare a un proxy su nodo manager.
- CPU sempre 0%: usare stream=false senza one‑shot per avere precpu_stats valorizzato o fare doppio campionamento client‑side se necessario.
- CPU >100%: è attesa su multi‑core, ma l’autoscaler normalizza per i core allocati e cap a 100% per replica, verificare NanoCPUs/Quota/Period/Cpuset in ServiceSpec/inspect.
- Limiti/risorse vuoti in UI: impostare deploy.resources nel servizio o via docker service update --limit‑cpu/--limit‑memory per popolare ServiceSpec.
- Avvio rumoroso: regolare STARTUP_PROXY_WAIT per dare tempo ai proxy di alzarsi e silenziare falsi positivi, verificando /_ping e /info pronti.


### Policy di log

- debug: metriche per servizio a ogni ciclo, dettagli SMTP mascherati (solo lunghezza password), diagnostica admin API.
- info: operazioni di scaling, invii email, bound di startup dei proxy e admin API listening, con tracciabilità delle decisioni.
- warning/error: conflitti di versione update out of sequence, errori di exec/stop, fallimenti reconcile e errori SMTP con invio immediato mail “ERROR” se configurato.


### Note finali

Questo progetto sfrutta esclusivamente Docker Engine API integrate nel daemon per discovery e mutate, restando aderente ai modelli dichiarativi di Swarm e ai principi di sicurezza del socket proxy a superfici minime.
L’architettura è pensata per ambienti di produzione con carichi variabili e requisiti di shutdown controllato, offrendo una pipeline di scaling prevedibile, osservabile e rispettosa delle quote di risorse assegnate ai servizi.
<span style="display:none"></span>

<div align="center">⁂</div>


