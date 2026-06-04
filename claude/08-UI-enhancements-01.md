1.  we removed the display width of 1400px across the board, but we should add it back for the new run/sweep form page.  The form being full width makes the input boxes comically wide.

2.  the timer is wonky.   It needs to not be tied to the page refresh, but should calculate the running time against the start time, and then audit against the exectution status to verify that it is in the warmup or benchmark phase.  The timer coloring is correct already.

3.  for sweeps, the currently running sweep iteration should be "glowing" in the and if a sweep iteration is in the cooldown state it should be glowing "ice blue."  If it failed, it should be red (no glow).  Glowing should be reserved for runs where something is actively happening.   Note that as-is, the running iteration is blue, but it should glow green.   

4. the "tiles" on the completed runs are too wide, they should be sized for the content.

5. we should add an additional set of tiles that match the OMB-sourced tiles that pull from the Redpanda prometheus metrics
  * publish rate (msg/sec) = redpanda_kafka_records_produced_total
  * consume rate (msg/sec) = redpanda_kafka_records_fetched_total
  * publush rate (mb/sec) = redpanda_rpc_received_bytes
  * consume rate (mb/sec) = redpanda_rpc_sent_bytes  

  those metrics may be at the topic or even partition granularity, so we will need to handle them carefully, ideally by knowing the topic name.  OMB uses a standard topic naming convention of test-topic-<identifier>-xxxx

6. any chart or tile needs a badge identifying the source of the data; Redpanda, OMB logs, OMB prometheus, etc
  * the latecny histograms and percentile curves do not have badges.

7.  Once a run completes, there is are charts for publish & E2E latency that don't populate.   Are those redundant with the actual time series data we see in the OMB-badged charts of the same name?

8.  Upon completion, the run log should collapse with a triangle twisty, same as the Config YAML section.

9.  on the sweeps "run comparison" page, the publish & consume rates are in msg/sec.  We need to also in clude MB/sec.  And include the P99.9 metrics for publish & E2E

10.  On the benchmark runs page, we should have the sweep ID included in the grid


