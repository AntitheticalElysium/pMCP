#!/bin/bash

# Define the absolute paths based on our directory structure
BENCHMARK_DIR="/home/antithetical/EPITA/PERSO/pMCP/benchmark"
SWE_BENCH_DIR="/home/antithetical/EPITA/PERSO/SWE-bench_Pro-os"

cd "$SWE_BENCH_DIR" || exit 1

# Find all grader_input JSON files in the benchmark directory
for file in "$BENCHMARK_DIR"/grader_input_*.json; do
  # Extract the basename, e.g., "grader_input_A_run0.json"
  basename=$(basename "$file")
  
  # Create the output directory name, e.g., "grading_results_A_run0"
  results_dir="${basename/.json/}"
  results_dir="${results_dir/grader_input_/grading_results_}"
  
  echo "--------------------------------------------------------"
  echo "Running grader for: $basename"
  echo "Output directory: $results_dir"
  echo "--------------------------------------------------------"
  
  python swe_bench_pro_eval.py \
    --raw_sample_path=helper_code/sweap_eval_full_v2.jsonl \
    --patch_path="$file" \
    --output_dir="$BENCHMARK_DIR/$results_dir" \
    --scripts_dir=run_scripts \
    --num_workers=1 \
    --dockerhub_username=jefzda \
    --use_local_docker > "$BENCHMARK_DIR/${results_dir}.log" 2>&1
    
  echo "Finished $basename. Results saved to $results_dir"
done

echo "All grading tasks completed."

