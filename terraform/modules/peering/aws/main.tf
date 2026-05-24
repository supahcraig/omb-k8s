data "aws_route_tables" "source" {
  vpc_id = var.source_vpc_id
}

data "aws_route_tables" "target" {
  vpc_id = var.target_vpc_id
}

resource "aws_vpc_peering_connection" "main" {
  vpc_id      = var.source_vpc_id
  peer_vpc_id = var.target_vpc_id
  auto_accept = true

  tags = merge(var.tags, {
    Name = "omb-to-target-peering"
  })
}

resource "aws_route" "to_target" {
  count = length(data.aws_route_tables.source.ids)

  route_table_id            = tolist(data.aws_route_tables.source.ids)[count.index]
  destination_cidr_block    = var.target_vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.main.id
}

resource "aws_route" "from_target" {
  count = length(data.aws_route_tables.target.ids)

  route_table_id            = tolist(data.aws_route_tables.target.ids)[count.index]
  destination_cidr_block    = var.source_vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.main.id
}

resource "aws_security_group_rule" "target_inbound_kafka" {
  count = var.target_security_group_id != "" ? 1 : 0

  type              = "ingress"
  security_group_id = var.target_security_group_id
  description       = "Allow OMB workers to reach Redpanda Kafka API"
  from_port         = 9092
  to_port           = 9093
  protocol          = "tcp"
  cidr_blocks       = [var.source_vpc_cidr]
}
