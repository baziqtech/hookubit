<?php

/**
 * HookuBit — Deployer entry point.
 *
 * This repository is Node + Go. Deployer is here purely as SSH task
 * orchestration: it gives us a release directory per deploy, an atomic
 * `current` symlink swap, and `dep rollback`. Nothing PHP runs on the server
 * and the server needs neither PHP nor Composer.
 *
 * Run it from the repository root:
 *
 *     make deploy                     # thin wrapper around `dep deploy`
 *     dep list                        # every task, with descriptions
 *     dep hookubit:preflight          # local-only checks, touches no host
 *     dep hookubit:verify             # read-only checks against the host
 *     dep rollback                    # READ deployments/deployer/README.md first
 *
 * Everything host-specific lives in deployments/deployer/hosts.yml.
 * The tasks live in deployments/deployer/hookubit.php.
 */

namespace Deployer;

require 'recipe/common.php';

import(__DIR__ . '/deployments/deployer/hookubit.php');
import(__DIR__ . '/deployments/deployer/hosts.yml');
