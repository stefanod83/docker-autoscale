# Docker Swarm Autoscaler

## Descrizione

Autoscaler containerizzato per Docker Swarm basato su monitoraggio tramite API Swarmpit. Supporta scalabilità CPU e RAM, alert email, configurazione dinamica, e alta disponibilità cluster.

## Struttura

- autoscaler/: codice Python autoscaler, configurazione YAML, email, cache, HA
- dashboard/: web React per visualizzazione dati e metriche
- stack/: file di deploy Docker Swarm

## Requisiti

- Docker Swarm cluster con Swarmpit API attiva
- Accesso API token Swarmpit
- SMTP server per notifiche mail

## Deploy

1. Configura `autoscaler/config.yml` con url, token Swarmpit e SMTP.
2. Personalizza `stack/docker-stack.yml` e i token.
3. Costruisci e deploya lo stack: 
```bash
docker stack deploy -c stack/docker-stack.yml autoscaler-stack
```
4. Accesso dashboard: http://<ip-host>:8080

## Variabili Configurazione

Configurabili sia in YAML che variabili ambiente per:

- soglie cpu, ram
- min/max repliche
- cooldown scale up/down
- email
- modalità cluster HA
- intervallo polling

---

## Miglioramenti futuri

- leader election con lock distribuito tramite Swarmpit
- alert più sofisticati
- supporto altri metrica / scalabilità verticale

