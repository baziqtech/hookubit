push:
	HOOKUBIT_ALLOW_PUSH=1 git push

# Deployer lives on the operator machine, not in this repo; the server needs
# neither PHP nor Composer. See deployments/deployer/README.md.
DEP ?= $(HOME)/.composer/vendor/bin/dep
DEP_ARGS ?=

# ---------------------------------------------------------------------------
# Deploying. THERE ARE TWO HOSTS AND NEITHER IS THE DEFAULT.
#
# `dev` and `prod` are separate machines pinned to the `dev` and `main`
# branches (deployments/deployer/hosts.yml). The environment is named in the
# TARGET, not in a variable:
#
#   - a variable can be set outside the command line. `export HOST=prod` in a
#     shell profile, or a stray line in a CI job, turns a later bare
#     `make deploy` into a production deploy with nothing on the command line
#     to show for it. A target name cannot be set from the environment.
#   - `make deploy-prod` is what ends up in shell history, in a runbook and in
#     a chat message, and it says which box it touched. `make deploy` plus an
#     invisible variable does not.
#
# So `make deploy` and `make rollback` take no argument and do nothing but
# refuse. The recipe refuses the same omission independently, one layer down:
# hookubit:host:guard fails `dep deploy` with no selector, so going round the
# Makefile does not get you a fan-out either.
# ---------------------------------------------------------------------------

.PHONY: push deploy deploy-dev deploy-prod \
        rollback rollback-dev rollback-prod \
        plan-dev plan-prod health-dev health-prod

define require_env
@printf '%s\n' \
  'make: `$(1)` does not name an environment, and there are two separate boxes.' \
  '' \
  '  make $(1)-dev     # the dev box, branch dev' \
  '  make $(1)-prod    # the LIVE box, branch main' \
  '' \
  '  deployments/deployer/hosts.yml is the inventory; its README has the reasoning.' >&2
@exit 1
endef

deploy:
	$(call require_env,deploy)

deploy-dev:
	$(DEP) deploy dev $(DEP_ARGS)

deploy-prod:
	$(DEP) deploy prod $(DEP_ARGS)

# Read deployments/deployer/README.md, "Rollback", first. The symlink rolls
# back; the database does not. hookubit:rollback:warn asks before anything moves.
rollback:
	$(call require_env,rollback)

rollback-dev:
	$(DEP) rollback dev $(DEP_ARGS)

rollback-prod:
	$(DEP) rollback prod $(DEP_ARGS)

# Read-only. `--plan` renders the task order and connects to nothing.
plan-dev:
	$(DEP) deploy --plan dev $(DEP_ARGS)

plan-prod:
	$(DEP) deploy --plan prod $(DEP_ARGS)

health-dev:
	$(DEP) hookubit:health dev $(DEP_ARGS)

health-prod:
	$(DEP) hookubit:health prod $(DEP_ARGS)
