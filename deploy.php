<?php

/**
 * HookuBit — Deployer entry point.
 *
 * This repository is Node + Go. Deployer is here purely as SSH task
 * orchestration: it gives us a release directory per deploy, an atomic
 * `current` symlink swap, and `dep rollback`. Nothing PHP runs on the server
 * and the server needs neither PHP nor Composer.
 *
 * TWO HOSTS, AND NEITHER IS THE DEFAULT. `dev` and `prod` are separate
 * machines pinned to the `dev` and `main` branches, and every command names
 * one. A run that would cover both is refused by hookubit:host:guard unless you
 * ask for it with --multi-host; a bare `make deploy` refuses too, and so does a
 * bare `make rollback`. Run it from the repository root:
 *
 *     make deploy-dev  / deploy-prod  # thin wrappers around `dep deploy <host>`
 *     make plan-dev    / plan-prod    # the task order, connecting to nothing
 *     make health-dev  / health-prod  # read-only probes against that host
 *     make rollback-dev / rollback-prod   # READ deployments/deployer/README.md first
 *
 *     dep list                        # every task, with descriptions
 *     dep hookubit:host:guard prod    # which ref is prod pinned to? decided
 *                                     # from hosts.yml alone, connects to nothing
 *
 * Everything host-specific lives in deployments/deployer/hosts.yml.
 * The tasks live in deployments/deployer/hookubit.php.
 */

namespace Deployer;

require 'recipe/common.php';

import(__DIR__ . '/deployments/deployer/hookubit.php');
import(__DIR__ . '/deployments/deployer/hosts.yml');
