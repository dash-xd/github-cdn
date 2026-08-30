package githubcdn

import (
	"net/http"

	"github.com/GoogleCloudPlatform/functions-framework-go/functions"
	"github.com/dash-xd/github-cdn/app"
)

func init() {
	functions.HTTP("Main", Main)
}

func Main(w http.ResponseWriter, r *http.Request) {
	app.Handler().ServeHTTP(w, r)
}
