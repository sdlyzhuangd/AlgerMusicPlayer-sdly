{
  "targets": [
    {
      "target_name": "bp_output",
      "sources": ["src/bp_output.cc"],
      "include_dirs": ["../node_modules/node-addon-api"],
      # node_api.gyp contains only a placeholder 'nothing' target; headers are
      # header-only, so no link-time dependency is needed.
      "defines": ["_WIN32_WINNT=0x0602", "NOMINMAX", "NODE_ADDON_API_CPP_EXCEPTIONS"],
      "cflags_cc": ["-std=c++17"],
      "cflags_c": ["-std=c11"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          # /utf-8: source files contain UTF-8 comments; without it cl.exe on a
          # Chinese code page (936) warns C4819 and may mangle string literals.
          "AdditionalOptions": ["/std:c++17", "/utf-8"]
        }
      },
      "conditions": [
        ["OS=='win'", {}],
        ["OS=='mac'", {
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++"
          }
        }],
        ["OS=='linux'", {
          "libraries": ["-lpthread", "-ldl", "-lm", "-lrt"]
        }]
      ]
    }
  ]
}
