{{/* Chart name, overridable. */}}
{{- define "webhook-platform.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "webhook-platform.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "webhook-platform.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "webhook-platform.labels" -}}
helm.sh/chart: {{ include "webhook-platform.chart" . }}
app.kubernetes.io/name: {{ include "webhook-platform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: webhook-platform
{{- end -}}

{{/* Selector labels. Call with (dict "ctx" $ "component" "worker"). */}}
{{- define "webhook-platform.selectorLabels" -}}
app.kubernetes.io/name: {{ include "webhook-platform.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "webhook-platform.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "webhook-platform.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Fully qualified image. Call with (dict "ctx" $ "image" .Values.x.image "defaultTag" "..."). */}}
{{- define "webhook-platform.image" -}}
{{- $tag := default .defaultTag .image.tag -}}
{{- if .ctx.Values.global.imageRegistry -}}
{{- printf "%s/%s:%s" .ctx.Values.global.imageRegistry .image.repository $tag -}}
{{- else -}}
{{- printf "%s:%s" .image.repository $tag -}}
{{- end -}}
{{- end -}}

{{/*
Environment sources, in precedence order: the chart ConfigMap, the chart Secret,
then any Secrets you manage yourself. Later entries win on duplicate keys, so an
existingSecret always overrides what the chart rendered.
*/}}
{{- define "webhook-platform.envFrom" -}}
- configMapRef:
    name: {{ include "webhook-platform.fullname" . }}-config
- secretRef:
    name: {{ include "webhook-platform.fullname" . }}-secrets
{{- with .Values.externalDatabase.existingSecret }}
- secretRef:
    name: {{ . }}
{{- end }}
{{- with .Values.externalRedis.existingSecret }}
- secretRef:
    name: {{ . }}
{{- end }}
{{- with .Values.secrets.existingSecret }}
- secretRef:
    name: {{ . }}
{{- end }}
{{- end -}}

{{/*
Environment for the four Go roles. Same ConfigMap, but a Secret carrying only
what services/data-plane/internal/config/config.go reads: DATABASE_URL,
REDIS_URL and the S3 credentials. JWT_SECRET and SESSION_SECRET are never
projected into a process whose whole job is making outbound HTTP requests to
customer-controlled URLs.

secrets.existingSecret is deliberately NOT in this chain - it is the control
plane's credential bundle. Database and Redis existingSecrets are, because the
data plane does read those.
*/}}
{{- define "webhook-platform.dataPlaneEnvFrom" -}}
- configMapRef:
    name: {{ include "webhook-platform.fullname" . }}-config
{{- if .Values.dataPlane.separateSecret }}
- secretRef:
    name: {{ include "webhook-platform.fullname" . }}-data-plane-secrets
{{- else }}
- secretRef:
    name: {{ include "webhook-platform.fullname" . }}-secrets
{{- end }}
{{- with .Values.externalDatabase.existingSecret }}
- secretRef:
    name: {{ . }}
{{- end }}
{{- with .Values.externalRedis.existingSecret }}
- secretRef:
    name: {{ . }}
{{- end }}
{{- if not .Values.dataPlane.separateSecret }}
{{- with .Values.secrets.existingSecret }}
- secretRef:
    name: {{ . }}
{{- end }}
{{- end }}
{{- end -}}

{{/* Pod-level security context. Call with (dict "uid" 65532). */}}
{{- define "webhook-platform.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: {{ .uid }}
runAsGroup: {{ .uid }}
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "webhook-platform.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop:
    - ALL
{{- end -}}

{{/*
Guard: this platform has no default credentials (ADR-0006). Failing here beats
failing at pod start with an unreadable config-validation stack trace.
*/}}
{{- define "webhook-platform.validate" -}}
{{- if and (not .Values.secrets.existingSecret) (not .Values.secrets.jwtSecret) -}}
{{- fail "secrets.jwtSecret is empty and secrets.existingSecret is unset. Generate one (openssl rand -base64 48) or point at a Secret you manage. This chart creates no default credentials." -}}
{{- end -}}
{{- if and (not .Values.secrets.existingSecret) (not .Values.secrets.sessionSecret) -}}
{{- fail "secrets.sessionSecret is empty and secrets.existingSecret is unset. Generate one (openssl rand -base64 48). It is NOT defaulted to jwtSecret: one key signing both API tokens and session cookies makes rotating either one invalidate both, and leaking either one leak both." -}}
{{- end -}}
{{- if and (not .Values.secrets.existingSecret) (not .Values.secrets.encryptionKey) -}}
{{- fail "secrets.encryptionKey is empty and secrets.existingSecret is unset. Generate one (openssl rand -base64 32, must decode to exactly 32 bytes)." -}}
{{- end -}}
{{/*
egress.allowPrivateNetworks is refused outright by the data plane when
APP_ENV=production (services/data-plane/internal/config/config.go), and app.env
defaults to production. Rendering it anyway installs a data plane that
CrashLoopBackOffs on every one of its four roles. Fail here, where the message
can name the fix.
*/}}
{{- if and .Values.egress.allowPrivateNetworks (eq .Values.app.env "production") -}}
{{- fail "egress.allowPrivateNetworks: true is rejected by the data plane when app.env is production - every Go role would exit at startup. Use egress.privateAllowlist with specific CIDRs (e.g. '10.20.0.0/16'), which works in production, or set app.env=staging if this really is not a production install." -}}
{{- end -}}
{{/*
Migrations run DDL and take session-scoped advisory locks. Through PgBouncer in
transaction pooling that is a half-applied migration and a _prisma_migrations
row stuck in `failed`. directUrl silently defaults to the pooled url, so the
only safe default is to refuse.
*/}}
{{- if and .Values.migrations.enabled (not .Values.externalDatabase.directUrl) (not .Values.externalDatabase.existingSecret) -}}
{{- fail "migrations.enabled is true but externalDatabase.directUrl is empty. Migrations must bypass PgBouncer: transaction pooling breaks DDL and the session-scoped advisory lock Prisma takes, which can leave a half-applied migration. Set externalDatabase.directUrl to a DIRECT connection (port 5432, not the pooler), or supply DIRECT_DATABASE_URL via externalDatabase.existingSecret." -}}
{{- end -}}
{{- end -}}
