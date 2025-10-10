import os
import yaml
import time
import threading
import logging
import docker
from docker import APIClient
import inspect
from cache import Cache
from emailer import send_email
from cluster_manager import LeaderElector

logger = logging.getLogger("Autoscaler")
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')

class AutoScaler:
    def __init__(self, config_file="/app/config.yml"):
        self.config_mtime = 0
        self.config_file = config_file
        self.load_config()
        self.cache = Cache(ttl=60)
        self.elector = LeaderElector(enabled=self.config.get('features', {}).get('ha_mode', 'standalone') != 'standalone')
        self.last_scaled = {}
        self.docker_client = docker.DockerClient(base_url='unix://var/run/docker.sock')
        self.api_client = APIClient(base_url='unix://var/run/docker.sock')
        threading.Thread(target=self._watch_config, daemon=True).start()

    def load_config(self):
        try:
            mtime = os.path.getmtime(self.config_file)
            if mtime != self.config_mtime:
                with open(self.config_file, 'r') as f:
                    self.config = yaml.safe_load(f)
                self.config_mtime = mtime
                logger.info(f"Configuration loaded or reloaded from {self.config_file}")
        except Exception as e:
            logger.error(f"Error loading config file: {e}")
            self.config = {}

    def _watch_config(self):
        while True:
            self.load_config()
            time.sleep(10)

    def can_scale(self, service, direction):
        cooldown_up = self.config.get('defaults', {}).get('scale_cooldown_up_sec', 300)
        cooldown_down = self.config.get('defaults', {}).get('scale_cooldown_down_sec', 600)
        cooldown = cooldown_up if direction == "up" else cooldown_down
        last = self.last_scaled.get(service.id, 0)
        elapsed = time.time() - last
        if elapsed < cooldown:
            logger.debug(f"Cooldown active ({elapsed:.1f}s < {cooldown}s) for service {service.name} direction {direction}")
        return elapsed > cooldown

    def _get_services(self):
        try:
            services = self.docker_client.services.list()
            return services
        except Exception as e:
            logger.error(f"Error fetching services from Docker: {e}")
            return []

    def _get_tasks(self, service_id):
        try:
            tasks = self.api_client.tasks(filters={'service': service_id})
            return tasks
        except Exception as e:
            logger.error(f"Error fetching tasks for service {service_id}: {e}")
            return []

    def _scale(self, service, replicas):
        try:
            spec = service.attrs['Spec'].copy()
            mode = spec.get('Mode', {})
            if 'Replicated' not in mode:
                logger.warning(f"Service {service.name} mode is not replicated; cannot scale")
                return

            current_replicas = mode['Replicated']['Replicas']
            if current_replicas == replicas:
                logger.info(f"Service {service.name} already at requested scale {replicas}")
                return

            mode['Replicated']['Replicas'] = replicas

            service.update(
                task_template=spec.get('TaskTemplate'),
                name=spec.get('Name'),
                labels=spec.get('Labels'),
                mode=mode,
                update_config=spec.get('UpdateConfig'),
                networks=spec.get('Networks'),
                endpoint_spec=spec.get('EndpointSpec')
            )

            logger.info(f"Scaled service {service.name} to {replicas} replicas")
            self.last_scaled[service.id] = time.time()
        except Exception as e:
            logger.error(f"Error scaling service {service.name}: {e}")

    def _send_alert_email(self, service, cpu_avg, ram_avg):
        try:
            smtp_conf = self.config.get('smtp', {})
            subject = f"[Autoscaler] Scaling Notification for {service.name}"
            message = (f"Service: {service.name}\n"
                       f"Replicas: {service.attrs['Spec']['Mode']['Replicated']['Replicas']}\n"
                       f"Avg CPU: {cpu_avg:.2f}%\n"
                       f"Avg RAM: {ram_avg:.2f}%\n"
                       f"Time: {time.strftime('%Y-%m-%d %H:%M:%S')}")
            send_email(smtp_conf, subject, message)
            logger.info(f"Sent alert email for {service.name}")
        except Exception as e:
            logger.error(f"Failed sending alert email for {service.name}: {e}")

    def _get_cpu_ram_avg(self, service):
        tasks = self._get_tasks(service.id)
        cpu_usages = []
        ram_usages = []
        for task in tasks:
            stats = task.get('Status', {}).get('ContainerStatus', {}).get('Stats', {})
            cpu = stats.get('cpu_percent', 0) or 0
            ram = stats.get('mem_percent', 0) or 0
            cpu_usages.append(cpu)
            ram_usages.append(ram)
        avg_cpu = sum(cpu_usages)/len(cpu_usages) if cpu_usages else 0
        avg_ram = sum(ram_usages)/len(ram_usages) if ram_usages else 0
        return avg_cpu, avg_ram

    def print_service_api_info(self):
        try:
            services = self.docker_client.services.list()
            if not services:
                logger.info("No services found to inspect")
                return
            service = services[0]
            logger.info(f"Service methods for {service.name}: {dir(service)}")
            logger.info(f"Service.update signature: {inspect.signature(service.update)}")
        except Exception as e:
            logger.error(f"Error during docker service API inspection: {e}")

    def main_loop(self):
        if self.config.get('debug', {}).get('print_service_api', False):
            self.print_service_api_info()

        while True:
            try:
                if self.elector.enabled and not self.elector.is_leader():
                    logger.info("Not leader, sleeping...")
                    time.sleep(60)
                    continue

                services = self._get_services()
                logger.info(f"Service keys: {list(services[0].attrs.keys()) if services else 'none'}")

                outstanding_containers = []
                replicated_count = 0
                skipped_count = 0

                for svc in services:
                    try:
                        labels = svc.attrs['Spec'].get('Labels', {})
                        svc_name = svc.name
                        spec_mode = svc.attrs['Spec'].get('Mode', {})
                        if 'Replicated' not in spec_mode:
                            skipped_count += 1
                            continue
                        replicas = spec_mode['Replicated'].get('Replicas')
                        if replicas is None:
                            skipped_count += 1
                            continue
                        replicas = int(replicas)
                        min_r = int(labels.get('swarm.autoscale.min', 1))

                        if replicas > min_r:
                            outstanding_containers.append(f"{svc_name} ({replicas})")
                        replicated_count += 1

                        max_r = int(labels.get('swarm.autoscale.max', 10))
                        cpu_min = float(labels.get('swarm.autoscale.percentage-min', 20.0))
                        cpu_max = float(labels.get('swarm.autoscale.percentage-max', 80.0))
                        ram_min = float(labels.get('swarm.autoscale.ram.min', 30.0))
                        ram_max = float(labels.get('swarm.autoscale.ram.max', 85.0))

                        cpu_avg, ram_avg = self._get_cpu_ram_avg(svc)

                        if (cpu_avg > cpu_max or ram_avg > ram_max) and replicas < max_r:
                            if self.can_scale(svc, "up"):
                                self._scale(svc, replicas + 1)
                                if self.config.get('features', {}).get('enable_email_alerts', False) and labels.get('swarm.autoscale.email', 'false').lower() == 'true':
                                    self._send_alert_email(svc, cpu_avg, ram_avg)
                        elif (cpu_avg < cpu_min and ram_avg < ram_min) and replicas > min_r:
                            if self.can_scale(svc, "down"):
                                self._scale(svc, replicas - 1)
                                if self.config.get('features', {}).get('enable_email_alerts', False) and labels.get('swarm.autoscale.email', 'false').lower() == 'true':
                                    self._send_alert_email(svc, cpu_avg, ram_avg)

                    except Exception as e:
                        logger.error(f"Errore parsing servizio: {e} - svc: {svc_name}")

                container_list = ", ".join(outstanding_containers) if outstanding_containers else "--"
                logger.info(f"Replicated > min: {container_list} | Validati: {replicated_count} | Skipped: {skipped_count}")

            except Exception as e:
                logger.error(f"Error in autoscaling loop: {e}")

            time.sleep(self.config.get('defaults', {}).get('check_interval', 300))

if __name__ == "__main__":
    autoscaler = AutoScaler()
    autoscaler.main_loop()
