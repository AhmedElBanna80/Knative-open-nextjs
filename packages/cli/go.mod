module github.com/knative-next/cli

go 1.25.1

require knative.dev/distribution-builder v0.0.0

require github.com/AhmedElBanna80/Knative-open-nextjs/packages/knative-next-builder v0.0.0

replace knative.dev/distribution-builder => ../distribution-builder

replace github.com/AhmedElBanna80/Knative-open-nextjs/packages/knative-next-builder => ../knative-next-builder
