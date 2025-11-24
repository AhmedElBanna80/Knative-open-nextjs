# Local Kubernetes Setup Guide

This guide will help you run the complete Knative Next.js framework on a local Kubernetes cluster with observability tools.

## Prerequisites

- Docker Desktop (with Kubernetes enabled) or Minikube
- kubectl
- Helm 3
- At least 8GB RAM allocated to Docker/Minikube

## Step 1: Set Up Local Kubernetes

### Option A: Docker Desktop (Recommended for Mac)

1. Open Docker Desktop preferences
2. Go to "Kubernetes" tab
3. Check "Enable Kubernetes"
4. Click "Apply & Restart"

### Option B: Minikube

```bash
# Install Minikube
brew install minikube

# Start with sufficient resources
minikube start --cpus=4 --memory=8192 --disk-size=50g

# Enable ingress
minikube addons enable ingress
```

## Step 2: Install Knative

```bash
# Install Knative Serving
kubectl apply -f https://github.com/knative/serving/releases/download/knative-v1.12.0/serving-crds.yaml
kubectl apply -f https://github.com/knative/serving/releases/download/knative-v1.12.0/serving-core.yaml

# Install Istio for networking
kubectl apply -l knative.dev/crd-install=true -f https://github.com/knative/net-istio/releases/download/knative-v1.12.0/istio.yaml
kubectl apply -f https://github.com/knative/net-istio/releases/download/knative-v1.12.0/istio.yaml
kubectl apply -f https://github.com/knative/net-istio/releases/download/knative-v1.12.0/net-istio.yaml

# Configure DNS (for local development)
kubectl apply -f https://github.com/knative/serving/releases/download/knative-v1.12.0/serving-default-domain.yaml

# Wait for Knative to be ready
kubectl wait --for=condition=Ready pods --all -n knative-serving --timeout=300s
```

## Step 3: Install Observability Stack

### Install Prometheus & Grafana

```bash
# Add Helm repos
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

# Create monitoring namespace
kubectl create namespace monitoring

# Install Prometheus
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false

# Wait for Prometheus to be ready
kubectl wait --for=condition=Ready pods -l app.kubernetes.io/name=prometheus -n monitoring --timeout=300s
```

### Install Jaeger (Distributed Tracing)

```bash
# Install Jaeger Operator
kubectl create namespace observability
kubectl apply -f https://github.com/jaegertracing/jaeger-operator/releases/download/v1.51.0/jaeger-operator.yaml -n observability

# Wait for operator
kubectl wait --for=condition=Ready pods -l name=jaeger-operator -n observability --timeout=300s

# Deploy Jaeger instance
cat <<EOF | kubectl apply -f -
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: jaeger
  namespace: observability
spec:
  strategy: allInOne
  allInOne:
    image: jaegertracing/all-in-one:latest
    options:
      log-level: info
  storage:
    type: memory
  ingress:
    enabled: false
  ui:
    options:
      dependencies:
        menuEnabled: true
EOF
```

### Install Loki (Log Aggregation)

```bash
# Install Loki
helm install loki grafana/loki-stack \
  --namespace monitoring \
  --set grafana.enabled=false \
  --set prometheus.enabled=false \
  --set promtail.enabled=true
```

## Step 4: Install MinIO Operator

```bash
# Install MinIO Operator
kubectl apply -k "github.com/minio/operator?ref=v5.0.11"

# Wait for operator
kubectl wait --for=condition=Ready pods -l name=minio-operator -n minio-operator --timeout=300s
```

## Step 5: Deploy Infrastructure

```bash
cd /Users/banna/POC/knative-next-framework

# Deploy Cerbos
kubectl apply -f packages/framework/infrastructure/cerbos/

# Deploy MinIO Tenant
kubectl apply -f packages/framework/infrastructure/minio/

# Note: Neon requires the Molnett operator which is still in development
# For now, we'll use a standard PostgreSQL deployment instead
```

## Step 6: Deploy PostgreSQL (Alternative to Neon)

```bash
# Install PostgreSQL using Bitnami chart
helm install postgres oci://registry-1.docker.io/bitnamicharts/postgresql \
  --namespace default \
  --set auth.username=neondb_owner \
  --set auth.password=password \
  --set auth.database=neondb

# Create files table
kubectl run postgres-client --rm -it --restart=Never --image=postgres:15 -- \
  psql -h postgres-postgresql.default.svc.cluster.local -U neondb_owner -d neondb -c \
  "CREATE TABLE IF NOT EXISTS files (id SERIAL PRIMARY KEY, name VARCHAR(255) UNIQUE, size BIGINT, uploaded_at TIMESTAMP);"
```

## Step 7: Access Observability Dashboards

### Grafana

```bash
# Port-forward Grafana
kubectl port-forward -n monitoring svc/prometheus-grafana 3000:80

# Access at http://localhost:3000
# Username: admin
# Password: (get it with the command below)
kubectl get secret -n monitoring prometheus-grafana -o jsonpath="{.data.admin-password}" | base64 --decode
```

### Prometheus

```bash
# Port-forward Prometheus
kubectl port-forward -n monitoring svc/prometheus-kube-prometheus-prometheus 9090:9090

# Access at http://localhost:9090
```

### Jaeger

```bash
# Port-forward Jaeger UI
kubectl port-forward -n observability svc/jaeger-query 16686:16686

# Access at http://localhost:16686
```

## Step 8: Build and Deploy File Manager

```bash
# Build the app
cd /Users/banna/POC/knative-next-framework
npm run build --workspace=apps/file-manager

# Build Docker image (using Minikube's Docker daemon if using Minikube)
# For Minikube:
# eval $(minikube docker-env)

docker build -t file-manager:latest -f packages/framework/runtime/Dockerfile apps/file-manager

# Generate Knative manifests
node packages/framework/dist/compiler/index.js \
  --dir apps/file-manager \
  --output ./manifests \
  --image file-manager:latest

# Deploy to Knative
kubectl apply -f ./manifests
```

## Step 9: Access the File Manager

```bash
# Get the service URL
kubectl get ksvc -n default

# For local access, port-forward or use the Knative domain
# Example:
kubectl port-forward -n default svc/next-index 8080:80

# Access at http://localhost:8080
```

## Monitoring Your Application

### View Logs

```bash
# View File Manager logs
kubectl logs -l serving.knative.dev/service=next-index -n default -f

# View all Knative service logs
kubectl logs -l serving.knative.dev/service -n default --all-containers=true -f
```

### View Metrics in Grafana

1. Open Grafana (http://localhost:3000)
2. Go to Dashboards
3. Import dashboard ID `15760` (Kubernetes / Views / Pods)
4. Import dashboard ID `15757` (Kubernetes / Views / Namespaces)

### View Traces in Jaeger

1. Open Jaeger (http://localhost:16686)
2. Select service from dropdown
3. Click "Find Traces"

## Troubleshooting

### Check Knative Status

```bash
kubectl get pods -n knative-serving
kubectl get ksvc -n default
```

### Check Infrastructure Status

```bash
kubectl get pods -n default
kubectl get pods -n monitoring
kubectl get pods -n observability
```

### View Events

```bash
kubectl get events -n default --sort-by='.lastTimestamp'
```

### Restart Services

```bash
# Restart a Knative service
kubectl delete pod -l serving.knative.dev/service=next-index -n default
```
