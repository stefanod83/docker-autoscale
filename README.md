
# Swarm Autoscaler – README

## Panoramica

Questo progetto fornisce autoscaling per servizi Docker Swarm basato su soglie CPU e RAM lette dai label del servizio, con raccolta metriche tramite Docker Engine API attraverso un proxy sicuro del socket e azioni di scale up/down eseguite dai manager.
Include un meccanismo di scale down “graceful” con pre‑stop eseguibile dentro il container, normalizzazione CPU in base ai core allocati, e notifiche email con batching per ridurre il rumore.

## Architettura

- Proxy socket read‑only distribuito globalmente: legge servizi, task e stats dai demoni locali in modo sicuro e senza accesso in scrittura.
- Proxy manager con scrittura: esegue update dei servizi e, se abilitato, comandi/stop nei container per il down “graceful”.
- Autoscaler singola replica su manager: interroga i proxy, calcola CPU/MEM, applica limiti min/max/cooldown, gestisce pre‑stop/stop e invia email con batching.
- Dashboard (facoltativa): UI per visualizzare repliche, limiti e stato servizi attraverso le API del proxy manager.


## Prerequisiti

- Swarm inizializzato e almeno un manager.
- Overlay network disponibile per i servizi dell’autoscaler.
- Accesso a socket Docker su ogni nodo (montato nei proxy).
- SMTP disponibile per notifiche (opzionale ma supportato).


## Distribuzione rapida (stack)

Esempio di docker-stack.yml minimale per proxy e autoscaler (aggiusta nomi rete/portainer/traefik secondo ambiente):

```yaml
version: "3.8"

networks:
  dockerapi:
    driver: overlay
    attachable: true

configs:
  autoscaler-haproxy:
    file: ./config/autoscaler-haproxy.yml

configs:
  autoscaler-smtp:
    file: ./config/autoscaler-smtp.yml

services:
  dsproxy_ro:
    image: tecnativa/docker-socket-proxy:latest
    networks: [dockerapi]
    deploy:
      mode: global
      endpoint_mode: dnsrr
      placement:
        constraints: [node.platform.os == linux]
    environment:
      # GET necessari per liste e stats
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
      LOG_LEVEL: "info"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    configs:
      - source: autoscaler-haproxy
        target: /usr/local/etc/haproxy/haproxy.cfg.template
        mode: 0444
    read_only: true
    tmpfs:
      - /usr/local/etc/haproxy
      - /run
      - /tmp

  dsproxy_rw:
    image: tecnativa/docker-socket-proxy:latest
    networks: [dockerapi]
    deploy:
      mode: replicated
      replicas: 1
      placement:
        constraints: [node.role == manager]
    environment:
      # Manager con scrittura per update servizi e opzionalmente exec/stop
      SERVICES: "1"
      TASKS: "1"
      INFO: "1"
      SYSTEM: "1"
      VERSION: "1"
      EVENTS: "1"
      PING: "1"
      CONTAINERS: "1"  # necessario per exec/stop nel down "graceful"
      POST: "1"
      LOG_LEVEL: "info"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    configs:
      - source: autoscaler-haproxy
        target: /usr/local/etc/haproxy/haproxy.cfg.template
        mode: 0444
    read_only: true
    tmpfs:
      - /usr/local/etc/haproxy
      - /run
      - /tmp

  autoscaler:
    image: your-registry/swarm-autoscaler:latest
    networks: [dockerapi]
    environment:
      READONLY_PROXY_DNS: "tasks.dsproxy_ro"
      READONLY_PROXY_PORT: "2375"
      MANAGER_PROXY_HOST: "http://dsproxy_rw:2375"
      POLL_INTERVAL: "15"
      DEFAULT_COOLDOWN: "120"
      LABEL_PREFIX: "autoscale"
      DEFAULT_MIN_REPLICAS: "1"
      DEFAULT_MAX_REPLICAS: "50"
      LOG_LEVEL: "info"
      SMTP_CONFIG_PATH: "/config/smtp.yml"
    configs:
      - source: autoscaler-smtp
        target: /config/smtp.yml
        mode: 0440
    deploy:
      mode: replicated
      replicas: 1
      placement:
        constraints: [node.role == manager]
      restart_policy:
        condition: any
```


## Configurazione SMTP (configs)

Crea il file config/smtp.yml per attivare le notifiche con batching:

```yaml
enabled: true
smtp:
  host: "smtp.example.com"
  port: 587
  starttls: true
  username: "autoscaler@example.com"
  password: "REPLACE_WITH_SECRET"
from: "Swarm Autoscaler <autoscaler@example.com>"
to_default:
  - "devops@example.com"
subject_prefix: "[Swarm Autoscaler]"
batch_window_seconds: 300
max_batch_events: 100
```

Suggerimento: gestisci password via Swarm secrets e referenziale in fase di lettura.

## Etichette supportate (servizi)

Aggiungi le label a livello di servizio (deploy.labels) perché il filtro dell’autoscaler legge ServiceSpec.Labels.

- autoscale.enable=true
Abilita il monitoraggio e le azioni di scaling su quel servizio.
- autoscale.cpu.max=75, autoscale.cpu.min=20
Soglie percentuali CPU per scala su/giù; la CPU è normalizzata ai core allocati per replica e limitata a 100.
- autoscale.mem.max=80, autoscale.mem.min=15
Soglie percentuali memoria per scala su/giù.
- autoscale.min=2, autoscale.max=10
Limiti inferiori/superiori alle repliche del servizio.
- autoscale.cooldown=120
Finestra in secondi che blocca nuove azioni dopo uno scale, per stabilizzare.
- autoscale.scale_down.enable=true|false
Consente di disabilitare lo scale down per servizi che non devono mai scendere.
- autoscale.pre_stop.cmd="sh -c 'graceful-stop \&\& wait-active-jobs'"
Comando di drain/flush eseguito nel container selezionato per il down “graceful”.
- autoscale.pre_stop.timeout=600
Timeout massimo in secondi concesso al comando pre‑stop prima di annullare il down.
- autoscale.stop.timeout=45
Timeout passato a /containers/{id}/stop del container target prima dell’update repliche.
- autoscale.notify.email.enable=true|false
Abilita le email per quel servizio; se non presente, eredita la configurazione globale.
- autoscale.notify.email.to=team@example.com,ops@example.com
Destinatari specifici per quel servizio, usati al posto dei default nel config.


## Logica CPU e metriche

- Le stats sono lette con stream=false; la percentuale CPU viene calcolata dai delta e poi divisa per i core allocati per replica (ServiceSpec Limits.NanoCPUs; in assenza, HostConfig NanoCpus/CpuQuota/CpuPeriod/Cpuset), quindi limitata a 100.
- La memoria è il rapporto usage/limit dal campo memory_stats; la media tra le repliche guida la decisione di scala.


## Esempi pratici – label set

1) Servizio web stateless con autoscaling standard:
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
```

2) Disabilitare lo scale down (solo up):
```yaml
deploy:
  labels:
    - "autoscale.enable=true"
    - "autoscale.scale_down.enable=false"
    - "autoscale.cpu.max=70"
    - "autoscale.min=2"
    - "autoscale.max=8"
```

3) Down “graceful” con drain di coda e timeout generosi:
```yaml
deploy:
  labels:
    - "autoscale.enable=true"
    - "autoscale.pre_stop.cmd=sh -c 'graceful-stop && drain-queue --wait'"
    - "autoscale.pre_stop.timeout=900"
    - "autoscale.stop.timeout=45"
    - "autoscale.cpu.min=25"
    - "autoscale.mem.min=20"
```

4) Forzare lo stop timeout anche senza logica di drain:
```yaml
deploy:
  labels:
    - "autoscale.enable=true"
    - "autoscale.pre_stop.cmd=:"
    - "autoscale.pre_stop.timeout=10"
    - "autoscale.stop.timeout=30"
```

5) Notifiche email per team dedicato con batching 5 min:
```yaml
deploy:
  labels:
    - "autoscale.enable=true"
    - "autoscale.notify.email.enable=true"
    - "autoscale.notify.email.to=backend@example.com,ops@example.com"
```

6) Limiti risorse per riflettere in dashboard e normalizzazione CPU:
```yaml
deploy:
  resources:
    limits:
      cpus: "0.50"
      memory: 512M
    reservations:
      cpus: "0.25"
      memory: 128M
  labels:
    - "autoscale.enable=true"
```


## Dashboard (opzionale)

- Il backend della dashboard deve puntare a un proxy su manager (es. dsproxy_rw) per leggere /services con status e /tasks.
- Imposta variabili: DOCKER_API_URL=http://dsproxy_rw:2375, DOCKER_API_VERSION in linea con il demone; LOG_LEVEL=debug per diagnostica.
- Se usi Traefik, aggiungi le label router/service e pubblica la porta della dashboard.


## Comandi utili

- Scala manuale:
    - docker service scale mysvc=5
    - docker service update --replicas 5 mysvc
- Forza rollout con nuova spec:
    - docker service update --force autoscale_dsproxy_ro
    - docker service update --force autoscale_dsproxy_rw
- Imposta limiti su servizio esistente:
    - docker service update --limit-cpu 0.5 --limit-memory 512M --reserve-cpu 0.25 --reserve-memory 128M mysvc


## Sicurezza e buone pratiche

- Mantieni i proxy con root FS in sola lettura e tmpfs su /usr/local/etc/haproxy, /run e /tmp.
- Se la piattaforma non supporta IPv6, assicurati che il template HAProxy bindi IPv4 (es. “bind :2375 v4only”).
- Non esporre i proxy all’esterno, usa overlay interna; limita le sezioni API abilitate al minimo indispensabile.
- L’autoscaler usa il proxy manager per update/exec/stop; assicurati che abbia POST e CONTAINERS abilitati solo dove necessari.


## Troubleshooting

- 503 “not a swarm manager” su /services: il backend sta colpendo un worker; punta al proxy su manager.
- 400 “invalid filter” su /services: non doppiare l’encoding dei filtri JSON; invia JSON semplice nella query.
- CPU sempre 0: evita “one-shot=true” nelle stats, oppure effettua doppio campionamento client‑side.
- Dashboard vuota: verifica che i label siano su ServiceSpec (deploy.labels), non solo su container.


## Variabili ambiente autoscaler

- READONLY_PROXY_DNS, READONLY_PROXY_PORT: scoperta degli endpoint per stats per nodo.
- MANAGER_PROXY_HOST: endpoint manager per /services, /tasks, update, exec/stop.
- POLL_INTERVAL: intervallo tra cicli di controllo.
- DEFAULT_COOLDOWN: cooldown di default se non specificato dai label.
- LABEL_PREFIX: prefisso dei label (default “autoscale”).
- SMTP_CONFIG_PATH: percorso del config SMTP per batching notifiche.
- LOG_LEVEL: livello log (info, debug, warning, error).


## Note sul comportamento

- Scala su quando media CPU > cpu.max o media MEM > mem.max.
- Scala giù quando media CPU < cpu.min e media MEM < mem.min, rispettando min e cooldown.
- Con pre_stop.cmd definito, lo scale down usa exec+stop mirato e solo dopo riduce Replicas; senza pre_stop, riduce Replicas direttamente.

