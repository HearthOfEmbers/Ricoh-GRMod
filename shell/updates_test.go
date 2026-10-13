package main

import (
	"encoding/base64"
	"reflect"
	"testing"
)

func TestRelaunchArgs(t *testing.T) {
	got := relaunchArgs([]string{"--data", "/x", "--webview-worker", "--after-update=12", "--updated-from=0.6.0", "-psn_0_123", "--browser"}, 77, "0.7.0")
	want := []string{"--data", "/x", "--browser", "--after-update=77", "--updated-from=0.7.0"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q", got)
	}
}

func TestUpdateKey(t *testing.T) {
	if k, err := base64.StdEncoding.DecodeString(updatePublicKey); err != nil || len(k) != 32 {
		t.Fatalf("public key unusable: %v %d", err, len(k))
	}
}

func TestRestarter(t *testing.T) {
	r := newRestarter()
	if r.pending() {
		t.Fatal("pending at start")
	}
	r.request()
	r.request()
	if !r.pending() {
		t.Fatal("not pending")
	}
	<-r.requested()
}
