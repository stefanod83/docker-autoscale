import os
import time
import threading
import logging

class LeaderElector:
    def __init__(self, enabled=True):
        self.enabled = enabled
        self._is_leader = not enabled  # If disabled, this is leader

    def is_leader(self):
        # TODO: Implement leader election with Swarmpit or external lock
        # For now standalone leader
        return self._is_leader
