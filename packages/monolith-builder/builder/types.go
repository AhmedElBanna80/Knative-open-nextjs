package builder

type BuildConfig struct {
	Params BuildParams
}

type BuildParams struct {
	Zone       string
	BaseImage  string
	Entrypoint string
}
