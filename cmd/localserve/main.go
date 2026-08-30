package main

import (
	"log"
	"net/http"
	"os"

	"github.com/dash-xd/github-cdn/router"
)

func main() {
	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	log.Printf("github-cdn listening on %s", addr)
	if err := http.ListenAndServe(addr, router.New()); err != nil {
		log.Fatal(err)
	}
}
