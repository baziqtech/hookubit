push:
	HOOKUBIT_ALLOW_PUSH=1 git push

# Deployer lives on the operator machine, not in this repo; the server needs
# neither PHP nor Composer. See deployments/deployer/README.md.
DEP ?= $(HOME)/.composer/vendor/bin/dep
DEP_ARGS ?=

deploy:
	$(DEP) deploy $(DEP_ARGS)
