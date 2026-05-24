resource "aws_vpc_peering_connection" "main" {
  vpc_id      = var.source_vpc_id
  peer_vpc_id = var.target_vpc_id

  tags = merge(var.tags, {
    Name = "omb-to-target-peering"
  })
}

resource "aws_route" "to_target" {
  count = length(var.source_route_table_ids)

  route_table_id            = var.source_route_table_ids[count.index]
  destination_cidr_block    = var.target_vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.main.id
}
